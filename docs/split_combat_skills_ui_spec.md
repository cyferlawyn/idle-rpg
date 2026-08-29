# Split Combat Skills — UI Representation Spec

Status: draft, ready for implementation (feeds t_5c232411)
Owner: UI/design pass, parent task t_b9c73340

## 1. Problem

`combat` is currently one monolithic `SkillName` entry (`state.ts`), leveled by a
single XP pool and read by `combat.ts` for both attack and defense math. The
design direction (matching the existing three-way `CombatStyle` split already
in state: `sword_and_board` / `dual_wield` / `two_handed`) is to split combat
into three trainable sub-skills, mirroring the gathering/crafting skills that
already exist as independent entries:

- `attack` — governs hit chance / reduces MISS_CHANCE, feeds `toonAttack`
- `strength` — governs damage roll (the `base` in `rollDamage`)
- `defence` — governs `toonDefense`, reduces incoming damage

`hp`/HP stays a separate pool as today (exhaustion pool, not a trainable
skill) — no change there. XP awarded per fight round splits across the three
new skills based on which stat the round exercised (e.g. attack roll → xp to
`attack`, damage dealt → xp to `strength`, damage avoided/blocked → xp to
`defence`), using the same `XP_TO_LEVEL` quadratic curve already shared by all
9 skills.

This spec covers ONLY the UI representation — data model and combat-math
changes belong to the implementation task, not this one.

## 2. Where it shows up

### 2.1 Skills panel (`#hud-skills` / `.hud-skills-list`)

Today: one row per `SkillName`, in `Object.entries(state.toon.skills)` order,
each row is:

```
<div class="skill-row">
  <div class="skill-row-label"><span>{name}</span><span>L{level}</span></div>
  <div class="hud-bar"><div class="hud-bar-fill xp" style="width:{pct}%"></div></div>
</div>
```

Change: `SkillName` grows from 9 entries to 11 (`combat` removed, `attack` /
`strength` / `defence` added). No new markup pattern needed — the existing
`.skill-row` template already generalizes to any skill name/level/xp triplet,
so the three new skills render for free once `state.toon.skills` has the new
keys. Only change needed in `main.ts` render(): none structurally, since it
already iterates `Object.entries`.

Grouping: to keep the panel scannable as it grows from 9 to 11 rows, insert a
non-interactive subheading strip so the three combat skills visually cluster
together, matching how a player already mentally groups "gathering" and
"crafting" skills even though the data has no such grouping today:

```
<div class="skill-group-label">Combat</div>
<div class="skill-row">...attack...</div>
<div class="skill-row">...strength...</div>
<div class="skill-row">...defence...</div>
<div class="skill-group-label">Gathering</div>
...
<div class="skill-group-label">Crafting</div>
...
<div class="skill-row">...agility...</div>  <!-- ungrouped, as today -->
```

This requires a small `SKILL_GROUPS: Record<SkillGroup, SkillName[]>` lookup
(sim-side, next to `SkillName`) that `main.ts` iterates instead of raw
`Object.entries(state.toon.skills)` — order becomes deterministic and
grouped rather than object-insertion-order dependent. `.skill-group-label`:
small uppercase caption, `opacity: 0.6`, `font-size: 0.65rem`, `margin-top:
0.4rem` — visually a sub-header, not a clickable control, consistent with the
panel's existing spare/text-only style (no icons anywhere else in the HUD
today, so we don't introduce per-skill icons here either — see §4).

### 2.2 Combat panel (`#hud-combat`)

No structural change. The style-badge (`sword_and_board` / `dual_wield` /
`two_handed`) stays exactly as-is — it's an equipment/stance concept,
orthogonal to the new attack/strength/defence skill split. Do NOT conflate
the two: a player can be in "Two-Handed" stance while leveling all three
combat skills identically; the stance affects *which* stat combat math
weights per round (future scope, out of UI-spec scope), not which skill rows
exist.

### 2.3 Overworld tooltip (`render/tooltip.ts`)

`describeNode()`'s monster branch already renders
`` `${def.hp} · ATK: ${def.attack} · DEF: ${def.defense}` `` and an XP-reward
line built from `Object.entries(def.xpReward)`. Once `def.xpReward` carries
`attack`/`strength`/`defence` keys instead of (or alongside) `combat`, this
line needs no code change — it already maps arbitrary skill-name keys to
label text via plain `${skill}`. Confirm at implementation time that
`def.xpReward` keys are renamed to match the new `SkillName` union (a
type-level change will catch any stale `combat` key automatically since
`Record<SkillName, number>`-typed data won't compile with an unknown key).

### 2.4 End-of-offline-session summary (`main.ts` `xpLines`)

Same shape as the tooltip: iterates skill-xp deltas generically. No new UI
work — the new skill names show up as three lines instead of one wherever
`combat` used to appear, in whatever order `Object.entries` yields. If
grouped/stable ordering matters here too (likely, for a summary the player
actually reads), reuse the same `SKILL_GROUPS` ordering helper from §2.1
rather than raw object iteration, for consistency.

## 3. States

- **Empty/zero XP** (fresh toon, e.g. a save before this feature ships and
  gets migrated): render L1, 0% bar, same as any other skill at creation —
  no special "new skill" badge/highlight. Keep it boring; this game has no
  precedent for calling out new content in the HUD panel, and a first-run
  callout is out of scope for a save-compatible skill rename anyway.
- **Level-up**: no per-skill flash/animation exists in the HUD today for any
  of the 9 existing skills (level-up is silent, only reflected via the log
  feed's normal event append). The three new skills get identical treatment
  — no new "combat skill leveled up" special-casing. If a future task wants
  level-up toasts, it should apply uniformly across all 11 skills, not be
  invented ad hoc here.
- **Migration of existing saves**: `storage.ts` load path needs a one-time
  migration (split `skills.combat` into `attack`/`strength`/`defence`, e.g.
  copy the same level/xp to all three, or split xp/3 — implementation's
  call) so old saves don't crash on a missing key. UI has nothing to render
  differently for a migrated vs. fresh-native save — by the time `render()`
  runs, `state.toon.skills` already has the new shape either way.

## 4. Iconography

No skill in the current UI has an icon — `public/icons.svg` only holds social
/doc icons for the landing page, not in-game skill glyphs. Consistent with
that existing pattern, do NOT introduce icons for attack/strength/defence
alone while every other skill (woodcutting, mining, agility, etc.) stays
text-only — that would make combat skills visually inconsistent with their
siblings for no functional reason. If icon iconography is ever wanted, it
should be proposed as a separate task covering all 11 skills uniformly, not
smuggled in via this split.

## 5. Interactions

No new interactive behavior. Skill rows are (and remain) read-only display —
no click handler exists on `.skill-row` today and none is added. The only
clickable combat-adjacent control stays the style-badge (stance cycling),
unchanged.

## 6. Summary of concrete deltas for the implementation task

1. `sim/state.ts`: `SkillName` union swaps `"combat"` → `"attack" |
   "strength" | "defence"`; add `SkillGroup` type + `SKILL_GROUPS` ordering
   map (`combat: [attack, strength, defence]`, `gathering: [...]`,
   `crafting: [...]`, ungrouped: `[agility]`).
2. `sim/combat.ts`: replace single `combatLevel` read with three reads;
   split XP award logic per round outcome.
3. `sim/monsters.ts`: `xpReward` keys renamed/expanded to match.
4. `sim/storage.ts`: migration step for old saves.
5. `main.ts` render(): swap `Object.entries(state.toon.skills)` for a
   `SKILL_GROUPS`-driven iteration that also emits `.skill-group-label`
   header rows between groups.
6. `style.css`: add `.skill-group-label` rule (see §2.1 for exact values).
7. No changes needed in `tooltip.ts` beyond the type-level rename already
   covered by (3).
