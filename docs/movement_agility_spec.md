# Movement Stat & Agility Skill — Design Spec

Status: design spec, implementation to follow in child tasks
(t_10fc3996 "Implement Movement stat and speed formula integration",
t_ab09a0bc "Implement Agility skill & passive training system").
Owns: the `Movement` derived stat, the `agility` skill, and how travel
ticks (`Travel.totalTicks` in `state.ts`, computed today via
`travelTicksBetween` in `zones.ts`) get discounted as Agility grows.

## 1. Why this exists

Root desired state (t_e53fe460): "Movement between activities is
currently way too fast." Today `travelTicksBetween` (zones.ts) returns
a flat zone-distance number (2-4 ticks) with no toon-side modifier at
all — every toon, at any point in the game, crosses the world at the
same fixed speed. There is no stat gating it and no sense of a toon
"getting better at moving." This spec adds:

1. A `Movement` derived stat (not stored directly — computed from the
   `agility` skill level, same pattern as any other derived value in
   this codebase; nothing new to persist beyond the skill itself).
2. A ninth skill, `agility`, trained **passively** by the toon actually
   moving (no explicit "train agility" directive/zone the way combat
   or woodcutting have one — see §4) whose level throttles travel time
   via the Movement stat.
3. A tuning table + caps so the effect is felt (start slow, meaningfully
   faster by max level) without making late-game travel instant.

## 2. Data structures

### 2.1 `SkillName` gains a 9th member

```ts
// state.ts
export type SkillName =
  | "combat"
  | "woodcutting"
  | "mining"
  | "fishing"
  | "cooking"
  | "smithing"
  | "alchemy"
  | "thieving"
  | "agility";
```

`agility` uses the existing `Skill { level: number; xp: number }` shape
— no new per-skill type needed. `createInitialState()` gets a new entry:

```ts
agility: { level: 1, xp: 0 },
```

### 2.2 Cumulative distance tracker (new `ToonState` field)

The root request explicitly ties growth to "cumulative distance moved
so far," not just current level — implementers must not conflate these
two things:

- **Agility *level*** is what the Movement-speed formula reads (§3).
  It comes from the *same* quadratic XP curve every other skill uses
  (`xp.ts::XP_TO_LEVEL`), for consistency with the rest of the
  progression system (see the quadratic-unification commit
  `8c81bc3`) — don't invent a second curve for this one skill.
- **Cumulative distance** is the thing that *feeds* Agility XP (§4) —
  it's the passive-training input, not a second read of the speed
  formula. Keep it as its own counter so a future UI ("you've walked N
  tiles") or achievement system has a real lifetime number to read,
  the same way `toon.kills` already exists as a lifetime counter
  alongside (not instead of) the `combat` skill's level/xp.

```ts
// state.ts, ToonState
/** Lifetime ticks spent actually traveling (Travel state active),
 * summed across every trip ever taken. Feeds passive Agility XP (see
 * docs/movement_agility_spec.md §4) and is available for future
 * UI/achievements. Not itself read by the speed formula — Agility
 * *level* is (see §3) — this is the passive-training input, not a
 * second speed multiplier. */
distanceMoved: number;
```

Initial value: `0`.

## 3. Movement stat: formula linking Agility level to speed

### 3.1 Speed multiplier

```ts
// zones.ts (or new movement.ts — implementer's call; keep it next to
// travelTicksBetween since both are consumed together in tick.ts)

/** Speed bonus granted per Agility level above 1, as a fraction of
 * base travel time removed. E.g. level 6 -> 5 * 0.03 = 0.15 -> 15%
 * faster. Tuned so early levels (1-10, reachable in the first session
 * or two of passive walking) give a noticeable but not dramatic
 * improvement -- see §5 progression table for concrete numbers. */
export const AGILITY_SPEED_BONUS_PER_LEVEL = 0.03;

/** Hard ceiling on how much travel time Agility can ever discount --
 * without this, a maxed-out toon would approach instant travel, which
 * defeats the "toon actually walks across the map" visual/UX goal
 * (state.ts's Travel comment, DESIGN.md overworld scope). 70% means
 * even a fully-trained toon still takes ~30% of base travel time --
 * fast, never instant. */
export const AGILITY_MAX_SPEED_BONUS = 0.7;

export function movementSpeedMultiplier(agilityLevel: number): number {
  const bonus = Math.min(
    AGILITY_MAX_SPEED_BONUS,
    AGILITY_SPEED_BONUS_PER_LEVEL * (agilityLevel - 1),
  );
  return 1 - bonus; // multiply base ticks by this; 1.0 at level 1, floor 0.3
}
```

### 3.2 Applying it to travel

`applyAction`'s `"travel"` case in `tick.ts` computes `totalTicks` via
`travelTicksBetween`. That call becomes:

```ts
const baseTicks = sameZone ? HUNT_TRAVEL_TICKS : travelTicksBetween(state.toon.zone, destination);
const totalTicks = Math.max(
  1, // never let discounting round a trip down to 0 ticks -- travel must
     // always take at least 1 tick so Travel state (and the overworld
     // map's interpolation) always has a real from->to frame to show.
  Math.round(baseTicks * movementSpeedMultiplier(state.toon.skills.agility.level)),
);
```

This is the *only* call site that needs to change per the acceptance
criteria in t_10fc3996 — `travelTicksBetween` itself stays a pure
zone-distance function (unchanged, still zone-pair based); the Agility
discount is layered on top at the point of use, not baked into the
zone table. Keeps zones.ts's existing contract (base distances only)
intact for anything else that might read it (map rendering already
uses raw `travel.totalTicks`, which now correctly reflects the
Agility-adjusted trip length once this multiplier is applied here).

## 4. Passive training: how Agility XP accrues

Unlike every other skill (trained via an explicit `train` directive
that requires standing in a `TRAINING_ZONE`), Agility has **no**
train-directive, **no** dedicated zone, and **no** UI-visible "go train
Agility" action — the root request is explicit that it trains
"passively by moving around the Overworld." Implementer contract:

1. In `tick.ts::step`, after `applyAction` runs the `"travel"` case
   (i.e. whenever `state.toon.travel` was non-null *before or after*
   this tick's apply — the toon spent this tick in transit), award
   passive Agility XP and bump the distance counter:

```ts
const wasTraveling = action.kind === "travel"; // this tick's action was travel
if (wasTraveling) {
  state.toon.distanceMoved += 1;
  const agility = state.toon.skills.agility;
  agility.xp += AGILITY_XP_PER_TRAVEL_TICK;
  const needed = XP_TO_LEVEL(agility.level);
  if (agility.xp >= needed) {
    agility.xp -= needed;
    agility.level += 1;
    state.log.push(`${state.toon.name} feels lighter on their feet (Agility level ${agility.level})`);
  }
}
```

Place this alongside the existing `train` XP-award logic in
`applyAction`'s `"travel"` case (not in a separate pass) so it shares
the exact same "gained XP, checked threshold, leveled up, logged"
shape every other skill already uses — no bespoke code path.

2. `AGILITY_XP_PER_TRAVEL_TICK` constant, alongside the existing
   `XP_PER_TRAIN_TICK = 5` in `tick.ts`:

```ts
const AGILITY_XP_PER_TRAVEL_TICK = 3;
```

Set slightly below the explicit-train rate (5) since travel is
unavoidable background activity the toon does *anyway* between every
other directive — full parity with active training would make Agility
trivially the fastest skill to max (the toon travels constantly by
construction of the ambient/directive loop), which undercuts the
"other 8 skills require deliberate choice" balance. 3 XP/tick keeps
Agility meaningfully slower to cap than a skill the player actively
commits to (see §5 for how many ticks/hours that implies).

3. Agility does **not** consume or check any exhaustion pool (§ see
   `docs/exhaustion_pools_spec.md`) — travel already has its own
   termination condition (`ticksRemaining <= 0` → arrival), and gating
   passive movement XP behind a pool would mean the toon literally
   cannot walk once fatigued, which breaks the game (every activity
   requires getting somewhere first). `poolForAction`'s `"travel"` case
   stays `null`, unchanged.

## 5. Example progression table

Using `XP_TO_LEVEL(level) = round(83 * level^2 + 100)` (existing
shared curve, `xp.ts`) and `AGILITY_XP_PER_TRAVEL_TICK = 3`:

| Agility level | XP to next level | Cumulative travel ticks to reach | Speed multiplier | Speed bonus | 3-tick base trip becomes | 4-tick base trip becomes |
|---:|---:|---:|---:|---:|---:|---:|
| 1  | 183   | 0      | 1.00 | +0%  | 3 ticks | 4 ticks |
| 2  | 432   | 61     | 0.97 | +3%  | 3 ticks | 4 ticks |
| 3  | 847   | 205    | 0.94 | +6%  | 3 ticks | 4 ticks |
| 5  | 2,175 | 743    | 0.88 | +12% | 3 ticks | 4 ticks |
| 10 | 8,300 | 3,977  | 0.73 | +27% | 2 ticks | 3 ticks |
| 15 | 18,775| 11,354 | 0.58 | +42% | 2 ticks | 2 ticks |
| 20 | 33,300| 24,637 | 0.43 | +57% | 1 tick  | 2 ticks |
| 25 | 51,875| 45,335 | 0.30 (capped, formula gives 0.28) | +70% (cap) | 1 tick | 1 tick |
| 30+| —     | ~70,000+ | 0.30 (floor, cap reached at ~L24) | +70% | 1 tick | 1 tick |

("Cumulative travel ticks to reach" = total ticks spent traveling,
summed from level 1, needed to hit that level — i.e.
`sum(XP_TO_LEVEL(1..level-1)) / 3`, rounded.)

Interpretation at the default tick rate (per `combat`/exhaustion specs'
assumption of ~1 tick per second-ish real time via `main.ts`'s
`setInterval` — implementer should confirm actual `TICK_MS` when
converting to wall-clock, this table only fixes tick counts):

- **Early game (L1-5):** ~12 minutes of cumulative travel to hit L5,
  barely perceptible speed change (+12%) — matches "starts slow."
- **Mid game (L10-15):** roughly an hour-plus of cumulative travel;
  meaningfully faster (a 4-tick trip drops to 2-3 ticks) — this is
  where the player should start *noticing* Agility as a stat, not just
  a number going up.
- **Late game (L20+):** many hours of accumulated walking; approaches
  the 70% cap, most short/medium trips (3-4 base ticks) collapse to 1
  tick. Longer trips (the 4-tick `meadow|cave` pairing) still take a
  visible 1-2 ticks rather than teleporting, preserving the "toon
  really walks" visual constraint from `state.ts`'s `Travel` doc
  comment.

The speed cap (§3.1, 70%) is deliberately reachable (~L24-25) rather
than asymptotic-only, so max-Agility has a concrete, testable target
level instead of "technically capped at infinity."

## 6. Balancing thresholds / guardrails for implementers

- **Floor:** `movementSpeedMultiplier` never returns below `1 -
  AGILITY_MAX_SPEED_BONUS` (0.3) — enforced by the `Math.min` clamp in
  §3.1, not by relying on level caps elsewhere in the codebase (there
  is no global level cap currently; don't add one here either, just
  clamp the bonus).
- **Floor on ticks:** `Math.max(1, ...)` in §3.2 — travel can never
  resolve in 0 ticks regardless of Agility level, preserving the
  overworld map's from→to interpolation contract (`overworld.ts`
  reads `travel.ticksRemaining`/`totalTicks` and divides; a 0-tick trip
  would produce a `NaN`/instant-jump frame).
- **No pool gating** (§4.3) — passive movement must never be blockable
  by an exhaustion pool; this is a "the toon can always at least walk"
  invariant.
- **Same XP curve as every other skill** (§2.2) — do not introduce a
  second leveling curve; Agility must level analogously so it stays
  comparable in the skills UI panel (already renders all `SkillName`
  entries generically per `hud`/stats rendering — confirm during
  implementation that adding `"agility"` to `SkillName` doesn't need a
  UI-side allowlist update; if it does, that's a UI follow-up task, not
  in scope for the two implementation children here to also do
  silently).
- **Constants live together:** `AGILITY_SPEED_BONUS_PER_LEVEL`,
  `AGILITY_MAX_SPEED_BONUS`, `AGILITY_XP_PER_TRAVEL_TICK` should be
  colocated (zones.ts for the first two since they're speed-formula
  constants consumed at the travel call site; tick.ts for the XP rate
  since it lives next to `XP_PER_TRAIN_TICK`) rather than scattered —
  keep this split, don't introduce a "config.ts" for just these three.

## 7. Acceptance checklist for downstream tasks

- [ ] `SkillName` includes `"agility"`; `createInitialState()` seeds
      `{ level: 1, xp: 0 }` for it.
- [ ] `ToonState.distanceMoved: number` added, initialized to `0`.
- [ ] `movementSpeedMultiplier(agilityLevel)` implemented per §3.1,
      clamped to the `[0.3, 1.0]` range.
- [ ] Travel-ticks call site (`tick.ts`'s `"travel"` case) applies the
      multiplier per §3.2, with the `Math.max(1, ...)` floor.
- [ ] Passive XP award wired into the `"travel"` apply-path per §4,
      using `AGILITY_XP_PER_TRAVEL_TICK = 3` and the shared
      `XP_TO_LEVEL` curve; level-up logs a distinct message (not reused
      from the generic `train` level-up line, so log output
      distinguishes "trained a skill" from "got better at moving").
- [ ] `distanceMoved` increments by 1 once per tick spent traveling
      (not per trip — a 4-tick trip adds 4, not 1).
- [ ] `poolForAction` continues to return `null` for `"travel"` —
      confirm no accidental pool coupling introduced.
- [ ] Unit tests: multiplier value at levels 1/10/25/50 matches §5
      table (within rounding); a simulated toon accumulating N travel
      ticks reaches the levels predicted in §5; a 0-tick-floor case
      (very high Agility, 1-tick base trip) never produces 0 or
      negative `totalTicks`.
