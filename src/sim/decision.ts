import type { WorldState, Directive, DirectiveType, PoolName } from "./state";
import { startQuest, QUESTS } from "./quests";
import { isPoolDepleted } from "./pools";

/**
 * An Action is what the decision layer decides to do this tick. Kept as a
 * plain data object (not a function) so it's trivially loggable/testable.
 */
export interface Action {
  kind: "idle" | "train" | "travel" | "fight" | "quest" | "rest";
  detail: string;
}

/**
 * Tier B: directive queue. Pops the front directive if present and returns
 * an action working toward it. Quest directives start (or resume) the active
 * quest via quests.ts; the actual step-by-step progress happens in tick.ts.
 */
function actionForDirective(state: WorldState, directive: Directive): Action {
  switch (directive.type) {
    case "train":
      return { kind: "train", detail: directive.target };
    case "hunt":
      return { kind: "travel", detail: directive.target };
    case "quest":
      if (state.toon.activeQuest?.questId !== directive.target) {
        startQuest(state, directive.target);
      }
      return { kind: "quest", detail: directive.target };
  }
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
  action: Action;
  pool: PoolName | null;
}

function ambientCandidates(state: WorldState): Candidate[] {
  const candidates: Candidate[] = [
    { action: { kind: "train", detail: "combat" }, pool: "stamina" },
    { action: { kind: "train", detail: "gathering" }, pool: "energy" },
    { action: { kind: "train", detail: "crafting" }, pool: "focus" },
    { action: { kind: "travel", detail: "nearest monster" }, pool: "stamina" },
  ];

  for (const quest of Object.values(QUESTS)) {
    const alreadyDone = state.toon.completedQuests.includes(quest.id);
    const isActive = state.toon.activeQuest?.questId === quest.id;
    if (alreadyDone || isActive) continue;
    candidates.push({ action: { kind: "quest", detail: quest.id }, pool: null });
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

function ambientAction(state: WorldState): Action {
  const candidates = ambientCandidates(state).filter(
    (c) => c.pool === null || !isPoolDepleted(state, c.pool),
  );
  if (candidates.length === 0) return { kind: "rest", detail: "all pools depleted" };

  const topScore = Math.max(...candidates.map((c) => poolScore(state, c.pool)));
  const topTier = candidates.filter((c) => poolScore(state, c.pool) === topScore);

  const pick = topTier[Math.floor(Math.random() * topTier.length)];
  return pick.action;
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
