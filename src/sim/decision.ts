import type { WorldState, Directive, DirectiveType, PoolName } from "./state";
import { startQuest, QUESTS, currentQuestStep } from "./quests";
import { isPoolDepleted, SKILL_POOL } from "./pools";
import { MONSTERS } from "./monsters";
import { pickHuntZone, isRecovered } from "./combat";
import { TRAINING_ZONE } from "./zones";

/**
 * An Action is what the decision layer decides to do this tick. Kept as a
 * plain data object (not a function) so it's trivially loggable/testable.
 */
export interface Action {
  kind: "idle" | "train" | "travel" | "fight" | "quest" | "rest";
  detail: string;
  /**
   * For "travel" actions only: what to do once the toon arrives (start a
   * fight, or nothing -- the next tick's decision naturally picks up
   * training/questing once the zone matches). Keeps tick.ts's travel
   * handling generic instead of hardcoding hunt-specific behavior.
   */
  travelPurpose?: "hunt" | "settle";
}

/** Ticks of local approach-within-a-zone before a hunt engages a monster
 * already in the current zone (flavor beat, not a cross-zone walk). */
export const HUNT_TRAVEL_TICKS = 2;

/**
 * Tier B: directive queue. Pops the front directive if present and returns
 * an action working toward it. Quest directives start (or resume) the active
 * quest via quests.ts; the actual step-by-step progress happens in tick.ts.
 */
function actionForDirective(state: WorldState, directive: Directive): Action {
  switch (directive.type) {
    case "train":
      return trainAction(state, directive.target);
    case "hunt":
      return huntAction(state);
    case "quest":
      if (state.toon.activeQuest?.questId !== directive.target) {
        startQuest(state, directive.target);
      }
      return questAction(state, directive.target);
  }
}

/**
 * Resolves what training actually does this tick. Skills each have a real
 * zone they're trained at (see sim/zones.ts) -- previously training just
 * ticked XP wherever the toon happened to be standing, with no location at
 * all. Now the toon must actually walk to that skill's zone first (visible
 * on the overworld map), same as hunting requires being in a monster's zone.
 */
function trainAction(state: WorldState, skill: string): Action {
  const targetZone = TRAINING_ZONE[skill as keyof typeof TRAINING_ZONE];
  if (!targetZone) return { kind: "train", detail: skill }; // unknown skill, fall back safely
  if (state.toon.zone !== targetZone) {
    return { kind: "travel", detail: targetZone, travelPurpose: "settle" };
  }
  return { kind: "train", detail: skill };
}

/**
 * Resolves what a quest actually does this tick. Most step kinds (travel,
 * gather, deliver) are still simple tick-progress placeholders and just
 * return a plain "quest" action for tick.ts to bump forward. Kill-type
 * steps are the exception: they only advance on a real combat kill event
 * (see quests.ts), so a quest sitting on a kill step must actually route
 * through hunting/fighting -- previously it returned a flat "quest" action
 * unconditionally, which did nothing for a kill step and left the toon
 * stuck showing "Questing: ..." with zero progress forever.
 */
function questAction(state: WorldState, questId: string): Action {
  const active = state.toon.activeQuest;
  if (active?.questId === questId) {
    const quest = QUESTS[questId];
    const step = quest && currentQuestStep(quest, active.stepIndex);
    if (step?.kind === "kill") {
      // Kill steps name a specific monster id as their target (e.g.
      // "village-rat" for Rat Infestation), not a zone -- look up that
      // monster's zone and walk the toon there via real cross-zone travel
      // rather than an instant zone swap.
      const targetZone = MONSTERS[step.target]?.zone;
      if (targetZone && state.toon.zone !== targetZone) {
        return { kind: "travel", detail: targetZone, travelPurpose: "settle" };
      }
      return huntAction(state);
    }
  }
  return { kind: "quest", detail: questId };
}

/**
 * Resolves what "hunt" actually does this tick: continue an active fight,
 * continue any in-flight cross-zone travel, walk to the nearest zone with
 * a monster if the current one has none, or (once in the right zone)
 * engage locally. Real position/travel state per DESIGN.md, not an
 * instant teleport into combat.
 */
function huntAction(state: WorldState): Action {
  if (state.toon.activeFight) {
    return { kind: "fight", detail: state.toon.activeFight.monsterId };
  }
  // Just fled or otherwise critically hurt: rest and let HP regen before
  // re-engaging, rather than immediately re-hunting the same zone at the
  // same low HP and flee-ing again -- the reported fight/flee/retry loop.
  if (!isRecovered(state)) {
    return { kind: "rest", detail: "hp" };
  }
  if (state.toon.travel) {
    return { kind: "travel", detail: state.toon.travel.to, travelPurpose: "hunt" };
  }
  const huntZone = pickHuntZone(state);
  if (huntZone && huntZone !== state.toon.zone) {
    return { kind: "travel", detail: huntZone, travelPurpose: "hunt" };
  }
  // Already in a zone with a monster -- a short local-approach beat
  // before engaging (see HUNT_TRAVEL_TICKS), handled by tick.ts.
  return { kind: "travel", detail: state.toon.zone, travelPurpose: "hunt" };
}

/**
 * Tier A: ambient priority weighting. Previously this hardcoded a single
 * action per directive type ("train" always meant "combat", "hunt" always
 * meant "nearest monster"), which meant only two real activities (plus an
 * "idle: no quest available" placeholder for the quest weight) could ever
 * come out of ambient mode -- the reported bug where the toon only ever
 * alternated between "training combat", "traveling towards nearest monster"
 * and "idle".
 *
 * Fixed per your steer: build every candidate activity (one per trainable
 * skill, hunting, and any quest the toon could start), score each by its
 * relevant pool's current fullness (untouched pools -- e.g. an available
 * quest, which is travel/step-based rather than pool-gated -- score as
 * always-full), take the highest-scoring tier, and roll among ties. This
 * naturally avoids re-picking an already-depleted pool (it'll never be in
 * the top tier while others are fuller) and adds real variety once several
 * pools are comparably fresh.
 */
interface Candidate {
  intent: AmbientIntent;
  pool: PoolName | null;
}

function ambientCandidates(state: WorldState): Candidate[] {
  const candidates: Candidate[] = [
    { intent: { kind: "train", skill: "combat" }, pool: "stamina" },
    { intent: { kind: "train", skill: "woodcutting" }, pool: "stamina" },
    { intent: { kind: "train", skill: "mining" }, pool: "stamina" },
    { intent: { kind: "train", skill: "fishing" }, pool: "energy" },
    { intent: { kind: "train", skill: "cooking" }, pool: "focus" },
    { intent: { kind: "train", skill: "smithing" }, pool: "focus" },
    { intent: { kind: "train", skill: "alchemy" }, pool: "vitality" },
    { intent: { kind: "train", skill: "thieving" }, pool: "nerve" },
    { intent: { kind: "hunt" }, pool: "stamina" },
  ];

  for (const quest of Object.values(QUESTS)) {
    const alreadyDone = state.toon.completedQuests.includes(quest.id);
    const isActive = state.toon.activeQuest?.questId === quest.id;
    if (alreadyDone || isActive) continue;
    candidates.push({ intent: { kind: "quest", questId: quest.id }, pool: null });
  }

  return candidates;
}

function poolScore(state: WorldState, pool: PoolName | null): number {
  // Quests (and anything else not pool-gated) are always scored as fully
  // available so they compete fairly for the top tier rather than being
  // permanently starved by a `null` sorting to 0/undefined.
  if (pool === null) return state.toon.pools.stamina.max;
  return state.toon.pools[pool].current;
}

/**
 * Ambient commitment is stored as an abstract intent (what to keep doing),
 * not a frozen concrete Action -- "hunt" in particular resolves to travel
 * OR fight depending on real toon.travel/activeFight state, and freezing
 * the exact Action would trap the toon on "traveling" forever even after
 * it arrives and a fight starts.
 */
type AmbientIntent =
  | { kind: "train"; skill: string }
  | { kind: "hunt" }
  | { kind: "quest"; questId: string };

function resolveIntent(state: WorldState, intent: AmbientIntent): Action {
  switch (intent.kind) {
    case "train":
      return { kind: "train", detail: intent.skill };
    case "hunt":
      return huntAction(state);
    case "quest":
      return questAction(state, intent.questId);
  }
}

function intentStillValid(state: WorldState, intent: AmbientIntent): boolean {
  switch (intent.kind) {
    case "train": {
      const pool = SKILL_POOL[intent.skill as keyof typeof SKILL_POOL];
      return pool ? !isPoolDepleted(state, pool) : false;
    }
    case "hunt":
      return !isPoolDepleted(state, "stamina");
    case "quest":
      // Valid if it's already the active quest (persisted), OR if it
      // hasn't been started yet at all (activeQuest null, not completed) --
      // that "not yet started" case covers the tick between committing to
      // a quest and tick.ts actually calling startQuest for it.
      if (state.toon.activeQuest?.questId === intent.questId) return true;
      if (state.toon.activeQuest) return false; // a *different* quest is active
      return !state.toon.completedQuests.includes(intent.questId);
  }
}

function ambientAction(state: WorldState): Action {
  // Stickiness: keep pursuing whatever ambient mode last committed to, as
  // long as it's still valid -- previously ambient re-rolled a brand new
  // pick every tick, which meant a tie among several available quests
  // reroll independently each tick (starting a new quest, then a
  // different one, then another...). Only re-roll once the current
  // commitment is no longer valid.
  if (state.ambientCommitment && intentStillValid(state, state.ambientCommitment as AmbientIntent)) {
    return resolveIntent(state, state.ambientCommitment as AmbientIntent);
  }

  const candidates = ambientCandidates(state).filter(
    (c) => c.pool === null || !isPoolDepleted(state, c.pool),
  );
  if (candidates.length === 0) {
    state.ambientCommitment = null;
    return { kind: "rest", detail: "all pools depleted" };
  }

  const topScore = Math.max(...candidates.map((c) => poolScore(state, c.pool)));
  const topTier = candidates.filter((c) => poolScore(state, c.pool) === topScore);

  const pick = topTier[Math.floor(Math.random() * topTier.length)];
  state.ambientCommitment = pick.intent;
  return resolveIntent(state, pick.intent);
}

/**
 * Core decision function: directive queue takes priority; ambient weighting
 * is the fallback. Kept pure aside from starting a quest on the WorldState
 * it's passed (no separate I/O), so it's still cheaply unit testable.
 */
export function getNextAction(state: WorldState): Action {
  const active = state.directives[0];
  if (active) return actionForDirective(state, active);
  return ambientAction(state);
}

/**
 * Per-tier prayer costs for issuing a directive (Tier B). Deliberately cheap
 * for v0 -- per DESIGN.md, actual costs/accrual are a tuning pass, not a
 * spec decision, and the loop should be visible/affordable early on.
 */
export const DIRECTIVE_COST: Record<DirectiveType, number> = {
  train: 1,
  hunt: 2,
  quest: 3,
};

/**
 * Attempts to queue a directive, spending prayer if affordable. Returns
 * false (no-op) if the player can't afford it -- callers (UI) should surface
 * that rather than silently queuing an unaffordable directive.
 */
export function issueDirective(
  state: WorldState,
  type: DirectiveType,
  target: string,
): boolean {
  const cost = DIRECTIVE_COST[type];
  if (state.prayer < cost) return false;

  state.prayer -= cost;
  state.directives.push({ type, target, issuedAt: state.tick });
  state.log.push(`Directive issued: ${type} ${target} (-${cost} prayer)`);
  return true;
}
