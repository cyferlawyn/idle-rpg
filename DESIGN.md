# idle-rpg — Design Doc v0.2

## Pitch

A near-zero-player browser RPG. Your toon — a paladin/crusader spreading a faith —
lives in a persistent world, autonomously walking, fighting, questing, and leveling.
The game plays itself. The player is **their god**, not their controller: nudge the
toon toward a goal ("focus on quests", "grind this skill", "go kill that boss") and
watch it figure out how to get there. Somewhere between a Progress Quest clone and a
tiny agent playing an RPG for you.

The interesting design problem isn't the RPG systems (those are well-trodden) — it's
the **autonomy layer**: how much of a brain does the toon get, and how does the player's
"nudge" actually bias its decisions without becoming a chat window or a full manual
control scheme. That tension is the thing worth writing devlog posts about.

## Setting: god and paladin (locked v0.2)

The toon is a paladin spreading their faith through the world. Converting townsfolk
(largely via quests — helping/impressing/converting a settlement) makes them pray.
Prayer is siphoned to the player, who is literally the toon's god. **Prayer is the
in-fiction source of nudge currency** — it's not the toon's own resource, it flows to
an entity outside the simulation, which is the actual answer to "why does the player
get more control over time": faith given by the world funds divine influence.

This directly replaced an earlier "renown/fame" framing for the same currency, which
didn't work: renown belongs to the toon and getting *more* famous doesn't obviously
buy the *player* more say over them — if anything it should make them more
independent. A resource that's explicitly siphoned to an outside entity (the god)
sidesteps that problem entirely.

**Systems stay generic, faith is a currency skin (deliberate choice).** The toon's
skills/quests/combat are not reframed as crusade-flavored verbs (no "convert
woodcutting", no forced theme-consistency across every system). Faith/prayer explains
where nudge currency *comes from*; once earned, it's spendable on any directive the
same way gold buys favors elsewhere. This keeps the sim generic and reusable if a
second toon archetype ever gets added later, at the cost of a slightly loose fictional
seam between "why do I have this currency" and "what can I spend it on." Traded off
deliberately — revisit only if playtesting makes that seam feel wrong.

Later expansion (not v0): the toon can build altars/temples/churches over the game,
which passively generate prayer on their own — a second, slower nudge-currency income
independent of active questing, and a nice example of the toon's own autonomous
choices feeding back into the player's power over it. Tracked as a stretch system
below, not required for the first playable milestone.

## Core Loop (v0 target)

1. World tick (fixed interval, e.g. every 1–2s of real time) advances toon state.
2. Toon's decision layer picks an action: travel, fight, loot, turn in quest, rest,
   train a skill, etc. — based on current goal + world state + a priority/utility score.
3. Action resolves (may take several ticks — travel, combat rounds).
4. Loot/XP/quest progress applied. UI reflects it (log feed + stat panel), no input
   required to keep the game running.
5. Player can nudge at any time: this changes weighting on the decision layer, doesn't
   directly execute actions. (Exact control granularity — see Open Questions.)

This needs to run correctly even with the tab closed / off-session: store
last-tick-timestamp, and on load, fast-forward/simulate elapsed ticks (with a cap or
diminishing returns to avoid absurd offline grinding, à la most idle games).

## The "Nudge" Model — the actual design problem

Three candidate levels of control, roughly in increasing player involvement. Don't
commit yet — build the decision layer so any of these can sit on top of it, then
playtest to see what's fun. All three are gated by **prayer** (nudge currency, see
Setting above) rather than being free — how much each tier costs, and whether cost
scales with directive specificity, is itself something to playtest rather than
decide up front.

**A. Priority weighting (softest, likely free/cheap).**
Player sets sliders/toggles: combat vs. exploration vs. questing vs. crafting weight.
Toon's utility-scoring decision function reads these as multipliers. No direct
commands, ambient influence only. Closest to a true idler. Low or no prayer cost —
this is "ambient" influence, not a direct command.

**B. Directive queue (medium, costs prayer per directive).**
Player can issue a small vocabulary of directives ("do quest X", "hunt zone Y", "go
train woodcutting to level N") that get pushed onto a directive stack, each costing
prayer to issue. Toon works through them autonomously — pathing, fighting, retrying —
until done or blocked, then falls back to (A)'s ambient behavior. This is the
"quest-giver, not puppeteer" mode and is probably the sweet spot to prototype first.

**C. Direct nudge / soft override (hardest, most prayer-expensive).**
Time-boxed direct suggestions ("do X next, just this once") that get inserted at the
front of the queue with a decay — after N minutes or on completion it reverts to
ambient/queued behavior. Priced as the most expensive tier since it's the most
puppeteer-like. Useful if (A)/(B) alone feel too passive in testing.

Plan: build the decision layer against a clean interface (`getNextAction(state,
directives, weights) -> Action`), ship (B) as the default control scheme for the
first playable milestone, keep (A) always active underneath it, and treat (C) as a
stretch feature to evaluate once (B) has been played for a while. Prayer accrual and
spend costs are explicitly a tuning pass, not a day-one design decision — this is
the thing to "sharpen while developing/testing" per your framing, don't lock it in
prematurely.

## Systems (v0 scope — keep small, expand later)

- **Stats/skills**: a handful of trainable skills (combat, a gathering skill, a
  crafting skill) with XP curves. No class system yet — single toon archetype.
- **Combat**: simple deterministic/RNG-light auto-battler math against tiered
  monsters. No twitch/positioning — this is a numbers loop, not an action game.
- **Quests**: a small quest graph (fetch/kill/deliver), enough to prove the
  directive-queue targeting a specific quest works end to end. Some quests should
  plausibly read as "converting"/impressing a settlement, to justify prayer income
  narratively — but this is flavor text on generic fetch/kill/deliver quests, not a
  distinct quest type (see Setting: systems stay generic).
- **World**: a handful of zones with a difficulty gradient, travel time between them.
- **Loot/inventory**: minimal — gear with flat stat bonuses, no deep itemization yet.
- **Prayer / nudge currency**: accrues from completed quests (and later, passively
  from built altars/temples — stretch, not v0). Spent by the player to issue
  directives (Tier B/C). Needs a simple accrual + balance model in `sim/` alongside
  skills/quests — track as its own state slice, not bolted onto gold.
- **Persistence**: localStorage first; consider a tiny backend later only if we want
  cross-device or "watch other people's toons" features (explicitly out of scope v0).
- **Offline simulation**: fast-forward elapsed time on load, capped.

## Devlog angle

Each blog post should map to a milestone, and the interesting content is almost
always "here's the decision/nudge problem I hit and how I resolved it" rather than
changelog-style feature lists (that's what APEX's posts already do — this can be a
bit more design-journal, matching the "sharpen while developing" framing you gave).

Planned milestone posts (subject to reality once we're building):
1. Announcing idle-rpg + the nudge problem (this doc, lightly edited)
2. Core loop + world tick running with a dumb/greedy decision layer, no player input
3. First directive queue + one full quest working end to end
4. Whatever surprised us about the nudge model after actually playing with it

## Tech stack recommendation

Going with **TypeScript + Vite**, no framework, no Canvas rendering (this is a stats/
log/list UI, not a real-time visual game — DOM is the right tool). Reasons:
- The decision layer, world tick, quest graph, and save/load are meaningfully more
  complex state machines than APEX's tower-defense loop. Plain JS made APEX's later
  updates (factions, prestige) visibly harder to extend per the commit history —
  worth avoiding here since this project is explicitly meant to run long-term with a
  devlog cadence.
- Vite gives fast local dev + trivial static build (deploys the same way as APEX:
  static output, droppable into Cloudflare or embedded in the landing site later).
- No game engine — this doesn't need one. A tick scheduler + a small pub/sub for UI
  updates is enough.
- Testing the decision layer in isolation (headless, no DOM) matters a lot here since
  "does the toon make sensible choices" is the actual crux of the project — plain
  TS + a test runner (vitest) covers that cleanly.

Deliberately NOT using a state machine library / ECS framework for v0 — the domain is
small enough that a hand-rolled tick loop + typed action/state objects will be easier
to reason about than framework machinery, and we can extract patterns into a tiny
library later if it turns out we need one.

## Repo layout (initial)

```
idle-rpg/
├── src/
│   ├── sim/           # world tick, decision layer, combat/quest resolution — headless, testable
│   │   ├── state.ts
│   │   ├── decision.ts
│   │   ├── combat.ts
│   │   ├── quests.ts
│   │   └── tick.ts
│   ├── data/          # static content: monsters, zones, quests, items (as data, not code)
│   ├── ui/            # DOM rendering, log feed, directive input
│   └── main.ts
├── test/              # vitest, targeting sim/ headlessly
├── public/
├── index.html
├── package.json
├── vite.config.ts
└── DESIGN.md          # this file, kept up to date as we learn things
```

## Future scope (explicitly post-v0 — captured now, not built now)

Two long-term concepts worth recording while fresh, so v0 systems don't
accidentally foreclose them later. Neither should influence v0 build priorities.

### Divine terminology: inspiration vs. intervention

Faith/prayer currency eventually splits into two distinct spend categories, not one
undifferentiated pool. Naming, locked now:

- **Divine Inspiration (steering)** — the existing three-tier model (ambient
  weighting → directive queue → soft override). Biases what the toon *chooses* to
  do; the toon still has to succeed on its own. This is the name for what v0
  currently calls a "directive" in code — an inspiration the player plants, not a
  command they issue.
- **Divine Intervention (miracle)** — direct, guaranteed alteration of an outcome:
  buff the toon mid-fight, curse an enemy, make gathering more abundant, and
  eventually **resurrection**. More expensive than inspiration, narratively framed as
  an actual miracle rather than a suggestion, and should stay visibly distinct in the
  UI/spend model from inspiration — if the two are numerically interchangeable,
  players will always pick whichever is cheaper and the flavor split disappears.

Resurrection matters beyond flavor: it's the answer to "the toon can die while the
player isn't watching, from a bad fight it shouldn't have taken." Framing that as a
bankable divine safety net (do I have enough faith saved up to matter) turns a
permadeath/bad-RNG risk into a real strategic choice (spend now vs. save for a
rainy day) instead of a design liability. Keep this in mind once combat balancing
starts even in v0 — don't design combat around permadeath being purely punishing
before intervention exists to soften it.

### Epic arc vs. side quests

Two distinct quest tracks, not one graph:

- **Epic arc (main story)** — a long, hand-authored quest chain carrying most of the
  narrative (plus toon monologue/introspection as flavor). Progresses in step with
  the toon's growing power, and **each checkpoint unlocks a new nudge/intervention
  mechanic** (e.g., early game only ambient weighting is available; a mid-arc
  checkpoint unlocks directive-queue targeting; a late checkpoint unlocks miracles).
  This makes mechanic unlocks narratively motivated — the god's reach into the world
  literally grows as the toon's faith/renown grows — rather than an arbitrary tech
  gate bolted on separately. Sparse by design; this is where authored content effort
  goes.
- **Side quests (fire-and-forget)** — lighthearted, low-stakes, everyday NPC
  problems (cat in a tree, rat infestation), burned through quickly, primarily a
  faith/XP content mill. Low narrative overhead by design — strong candidate for
  templating/light procedural generation later so the toon always has *something*
  to do without every quest needing hand-written stakes. This is what keeps an idle
  sim watchable without demanding a hundred hand-authored quests.

Practical implication for v0: keep the quest data model general enough that a quest
can optionally reference "unlocks mechanic X on completion" and a narrative-weight
flag (epic vs. side), even though v0 itself only needs a couple of side-quest-style
fetch/kill/deliver quests to prove the directive queue works end to end. Don't build
the epic arc's content or the unlock-gating logic yet — just don't paint the data
model into a corner that can't grow into it.

### Visual overworld + dedicated fight screen

v0 ships as a stats/log-feed DOM UI (per the Tech stack section) and that's the
right call for now — a numbers-and-text idler is legitimately watchable and far
faster to build against while the sim/decision/quest systems are still being
figured out. But the long-term ambition is a 2D overworld the toon visibly walks
around in (zones, travel between them rendered as actual movement) plus a separate
fight screen when combat triggers — something pleasant to glance at on a second
monitor, not just a scrolling log.

This is deliberately not a v0 feature (real art/tile assets, a renderer, animation
timing — all substantial scope on their own) but it does have one architectural
consequence worth respecting *starting now*, not retrofitted later:

- **`sim/` must stay a pure, renderer-agnostic state machine.** It already is (state/
  decision/tick have no DOM coupling) — keep it that way as combat, quests, and
  prayer get built out. A future canvas/2D renderer should be able to subscribe to
  `WorldState` and draw it without any changes to `sim/` itself, the same way the
  current DOM list-rendering in `main.ts` does.
- **Model position/movement as real state now, even though nothing renders it
  yet.** Zones/travel already exist conceptually (see World system above) — give
  travel an actual position-over-time representation (e.g. current zone + progress
  toward destination) rather than an instant teleport-on-arrival, so a future map
  view has real movement data to animate instead of the concept having to be
  invented retroactively.
- **Combat resolution should be structured as a resolvable sequence of rounds/
  events, not a single collapsed dice roll.** That gives a future fight screen
  actual beats to animate (hit, miss, ability, kill) rather than only a before/after
  HP delta. Doesn't need a real "engine" for v0 — just don't collapse combat into
  one opaque function call that only returns a final result.

None of this changes v0 scope or the DOM-only UI decision — it's a "don't box
ourselves out of this later" constraint on how `sim/` is shaped while we build it.

## Open questions (track, don't block on)

- Prayer accrual rate and per-tier directive costs — needs actual play/tuning, not a
  spec decision. Start generous (cheap directives) so the loop is visible early, tune
  down once there's something to balance against.
- Exact directive vocabulary for tier B control — start with 3–4 verbs, expand only
  if playtesting shows the toon gets stuck without more.
- How aggressive should offline-time fast-forwarding be before it undermines the
  "watch it happen" appeal.
- Whether combat needs any player-visible tactical choice at all, or stays fully
  automatic forever.
- Single toon only, or eventually a small party — v0 is single toon, don't scope
  creep into party management yet.
- Altars/temples as a passive prayer-income building system — deliberately deferred
  past v0; revisit once the base quest/prayer loop is proven fun on its own.
- Visual overworld/fight-screen tech choice (raw canvas vs. a lightweight 2D lib
  like PixiJS/Kaboom) — deferred until v0's DOM UI proves the loop is fun; decide
  once there's a real feel for how much movement/combat detail is worth animating.
