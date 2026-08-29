# Exhaustion Pool System — Design Spec

Status: design spec, implementation to follow in child tasks.
Owns: generic pool abstraction backing every skill category's
"how long until the toon has to stop and do something else" mechanic.
Source of truth for: `src/sim/pools.ts` (existing, to be refactored per
this spec), and the combat/gathering/crafting-specific pool
implementations built on top of it.

## 1. Why this exists (reconciling with current code)

`src/sim/pools.ts` already has a generic `ResourcePool { current, max }`
type and a 5-pool setup (`stamina, energy, focus, vitality, nerve`)
mapped across all 8 skills via `SKILL_POOL`. That's a reasonable first
cut, but the actual desired state (t_faec54a2, the root request) is
narrower and more specific:

- **combat → HP.** Not a generic "stamina" — literal hitpoints, shared
  with the existing `toon.hp`/`toon.maxHp` fields and the flee-at-25%
  logic in `combat.ts`. At 0 HP, combat ends and a **new activity is
  randomly selected** from non-combat activities (this is the one pool
  category with special depletion behavior — see §4).
- **gathering → fatigue.** One shared pool for all gathering skills
  (woodcutting, mining, fishing — anything that pulls raw materials from
  the world). Ends the gathering activity at 0, no random reassignment
  (falls through to ambient/idle re-evaluation next tick, same as any
  other depleted-pool stop).
- **crafting → concentration.** One shared pool for all crafting/
  production skills (cooking, smithing, alchemy — anything that
  transforms materials). Same depletion behavior as fatigue.
- Thieving doesn't map cleanly to any of the three per the root request
  ("HP and two dedicated pools is all we need") — ruling: fold it into
  the **fatigue** pool (nerve/composure is exertion-adjacent) until a
  fourth category is explicitly requested. Don't add a 4th pool
  speculatively.

**Ruling for implementers:** collapse `pools.ts`'s 5-pool
`stamina/energy/focus/vitality/nerve` model down to the 3 pools above.
`toon.hp`/`maxHp` (already in `state.ts`) *is* the combat pool — don't
add a redundant `pools.stamina`; combat's exhaustion pool literally is
HP. `fatigue` and `concentration` are new entries in `ToonState.pools`
replacing `energy/vitality/nerve` and `focus` respectively. Update
`SKILL_POOL` to:

```ts
export const SKILL_POOL: Record<SkillName, PoolCategory> = {
  combat: "hp",
  woodcutting: "fatigue",
  mining: "fatigue",
  fishing: "fatigue",
  thieving: "fatigue",
  cooking: "concentration",
  smithing: "concentration",
  alchemy: "concentration",
};
```

This is a deliberate scope-down, not a bug fix on the current code —
flag it as an intentional breaking change from the existing 5-pool
shape when the combat/gathering/crafting child tasks touch `pools.ts`.

## 2. Core data structures

```ts
/** The three exhaustion pool categories. "hp" is combat's; the other two
 * are each shared across every skill in that category. */
export type PoolCategory = "hp" | "fatigue" | "concentration";

export interface ExhaustionPool {
  current: number;
  max: number;
  /** Flat amount drained per tick while an activity in this pool's
   * category is actively running. Activity-specific multipliers (e.g. a
   * tougher monster draining HP faster) are applied at the call site,
   * not baked into this config -- see §3. */
  drainPerTick: number;
  /** Flat amount regenerated per tick while NOT actively draining. */
  regenPerTick: number;
}

/** Config table, one entry per category. Concrete numbers tuned so a
 * sustained activity lasts ~3-5 minutes at the default tick rate before
 * hitting 0 (HP is the deliberate exception -- it depends on monster
 * matchups, not a flat timer; see §3.1). */
export const POOL_CONFIG: Record<PoolCategory, ExhaustionPool> = {
  hp: { current: 100, max: 100, drainPerTick: 0, regenPerTick: 1 },
  fatigue: { current: 100, max: 100, drainPerTick: DRAIN_3_5MIN, regenPerTick: REGEN_IDLE },
  concentration: { current: 100, max: 100, drainPerTick: DRAIN_3_5MIN, regenPerTick: REGEN_IDLE },
};
```

`DRAIN_3_5MIN`/`REGEN_IDLE` are placeholders for the actual tuning pass
(depends on final tick rate, `TICK_MS`, and target session length) —
child tasks own picking concrete numbers, this spec only fixes the
*shape* and the *ratio* constraint below.

**Tuning constraint (must hold for any concrete numbers chosen):**
`max / drainPerTick` ticks to empty from full ≈ 3–5 minutes of wall
time at whatever tick interval `main.ts`'s `setInterval` uses. HP is
explicitly exempt (§3.1) — its "time to empty" is monster-dependent by
design, not a flat timer.

`WorldState.toon.pools` becomes:

```ts
pools: {
  fatigue: ResourcePoolState;
  concentration: ResourcePoolState;
  // hp/maxHp stay as their own top-level ToonState fields (unchanged) --
  // "hp" as a PoolCategory routes to those fields, not a third pools{} entry.
}
```

## 3. Depletion (draining)

One pool is "active" per tick: whichever `PoolCategory` the current
`Action` maps to (see `poolForAction` in `tick.ts`, extend its switch to
route `fight → "hp"`, gathering-skill trains → `"fatigue"`,
crafting-skill trains → `"concentration"`). Only the active pool drains
that tick; every other pool regenerates (already the behavior of
`regenIdlePools`, keep that function, just repoint it at the new
3-category shape).

```ts
function drainActivePool(state, category, amountOverride?) {
  if (category === "hp") {
    state.toon.hp = max(0, state.toon.hp - (amountOverride ?? 0));
    return state.toon.hp;
  }
  const p = state.toon.pools[category];
  p.current = max(0, p.current - (amountOverride ?? POOL_CONFIG[category].drainPerTick));
  return p.current;
}
```

### 3.1 HP is drained by combat damage, not a flat per-tick amount

Unlike fatigue/concentration (fixed `drainPerTick`), HP's "drain" *is*
the existing `resolveFightRound` damage-to-toon roll in `combat.ts` —
there is no separate flat HP drain on top of combat damage. This is
already how the code works and should stay that way: `poolForAction`
still reports `"hp"` as the active category for a `fight` action (so
regen correctly pauses for HP and continues for fatigue/concentration
while fighting), but the actual `current -= X` for HP happens inside
`resolveFightRound`, not via a generic `drainPool` call. Treat
`resolveFightRound`'s existing damage application as the HP pool's
depletion mechanism — don't duplicate it with a second flat drain.

## 4. Depletion → termination → reselection (the state machine)

```
   [ACTIVE: pool > 0]
        │ tick, pool drains
        ▼
   [pool == 0] ──────────────► [TERMINATED]
        │                            │
        │                    category == "hp"?
        │                            │
        │                  yes ──────┴────── no
        │                   │                 │
        │                   ▼                 ▼
        │         pick random NON-combat   fall through to
        │         activity, start it       normal decision
        │         immediately (same tick   layer next tick
        │         or next -- see below)    (ambient re-roll /
        │                                  directive re-check,
        │                                  no special-case)
```

- **fatigue/concentration termination:** no special reassignment logic
  needed — this is already how `tick.ts`'s `step()` works today (`if
  (pool && isPoolDepleted(...)) { ...; action = rest }`) and generic
  directives already get shifted off the queue on depletion. Gathering/
  crafting child tasks should confirm this existing mechanism covers
  their pool without new code, only wiring `SKILL_POOL` entries
  correctly (§1).
- **HP termination (combat-specific, new):** at HP == 0, this is
  *stricter* than the current flee-at-25%-HP behavior — flee is a
  pre-death safety valve during an ongoing fight; HP == 0 is now a hard
  stop that must also force a reassignment, not just end the current
  fight. Implementer contract:
  1. `resolveFightRound` (or a new wrapper) detects `toon.hp <= 0`,
     clears `activeFight`, logs a distinct "collapses" event (different
     from the existing flee log line — flee is voluntary retreat above
     0 HP, this is involuntary collapse at 0).
  2. Immediately select a replacement activity via the **existing**
     ambient-candidate machinery in `decision.ts`
     (`ambientCandidates`/`poolScore`), but with combat/hunt candidates
     filtered OUT of the pool (can't reassign back into combat at 0 HP —
     that would just re-trigger the same collapse). Reuse
     `ambientCandidates(state).filter(c => c.intent.kind !== "hunt" && !(c.intent.kind === "train" && c.intent.skill === "combat"))`
     rather than writing a second selection algorithm.
  3. Set `state.ambientCommitment` to the picked intent directly (same
     field ambient mode already uses) so next tick's `getNextAction`
     naturally picks it up — no new dispatch path needed.
  4. If a directive was active when collapse happened (not just
     ambient), the existing directive is **not** silently dropped
     permanently — per the "generic directives are consumed on
     depletion" precedent in `tick.ts`, shift it off the queue the same
     way a fatigue/concentration depletion already does for train/hunt
     directives, then fall to the reassignment above. Quest directives
     that happen to route through combat (kill-step quests) are the one
     exception: leave the quest directive in place (matches existing
     quest-directive-survives-depletion rule) — the toon will naturally
     resume the kill step once HP recovers, same as it already resumes
     after fleeing.
  5. HP regen after collapse uses the same `regenHp`/`HP_REGEN_PER_TICK`
     path that already exists for post-flee recovery — no new regen
     mechanism, just make sure it keeps running while the toon is doing
     the randomly-picked replacement activity (already true: `regenHp`
     only skips while `activeFight` is set).

## 5. Recovery (regeneration)

Unchanged from the existing `regenIdlePools` pattern, generalized to 3
categories: every category *other than* the currently-active one
regenerates `regenPerTick` per tick, capped at `max`. HP regen keeps its
own existing `regenHp`/`HP_REGEN_PER_TICK` function (already correctly
gated on `!activeFight`) rather than being folded into the generic pool
regen loop, since HP lives on `toon.hp`/`maxHp`, not `toon.pools`.

## 6. Query / deplete / recover API (what child tasks implement against)

```ts
// pools.ts
export function isPoolDepleted(state: WorldState, category: PoolCategory): boolean;
export function poolFraction(state: WorldState, category: PoolCategory): number; // 0..1, for UI/ambient scoring
export function drainPool(state: WorldState, category: PoolCategory, amount?: number): number; // returns new current
export function regenIdlePools(state: WorldState, activeCategory: PoolCategory | null): void;

// combat.ts (HP-specific, category = "hp" conceptually but reads/writes toon.hp directly)
export function isRecovered(state: WorldState): boolean; // existing, keep
export function isCollapsed(state: WorldState): boolean; // new: toon.hp <= 0
```

Callers (`tick.ts::step`, `decision.ts`) only ever go through this
surface — no module outside `pools.ts`/`combat.ts` should read/write
`toon.pools[...]` or `toon.hp` directly. This is already mostly true in
the current codebase; keep it that way so the 3 implementation tasks
(combat/gathering/crafting) don't each invent their own access pattern.

## 7. Acceptance checklist for downstream tasks

- [ ] `pools.ts` reduced to `fatigue`/`concentration` in `toon.pools`;
      `SKILL_POOL` updated per §1.
- [ ] `poolForAction` (`tick.ts`) routes `fight` → `"hp"`, gathering
      skill trains → `"fatigue"`, crafting skill trains →
      `"concentration"`.
- [ ] HP depletion at 0 triggers forced-stop + random non-combat
      reassignment per §4, distinct from the existing flee-at-25%
      behavior (both must coexist: flee ≠ collapse).
- [ ] Fatigue/concentration depletion confirmed to already terminate
      the activity via the existing generic `isPoolDepleted` → rest
      path in `tick.ts`; no bespoke termination code needed for those
      two.
- [ ] Regeneration for all three pools verified idle-only (active
      category never regens same tick it drains).
- [ ] Unit tests (per each child task) cover: depletion reaches exactly
      0 and stays clamped, forced termination fires exactly once at the
      0 boundary (not re-fired every tick while at 0), random
      reassignment for HP excludes combat, and recovery resumes once
      not-active.
