import type { WorldState, Directive, DirectiveType } from "./state";
import { startQuest } from "./quests";

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
 * Tier A: ambient priority weighting. Picks a directive TYPE (not a specific
 * target) proportional to the current weights, then invents a generic action
 * for it. This is the fallback "the toon does *something* useful" behavior
 * when there's no explicit directive queued.
 */
function ambientAction(weights: Record<DirectiveType, number>): Action {
  const entries = Object.entries(weights) as [DirectiveType, number][];
  const total = entries.reduce((sum, [, w]) => sum + Math.max(w, 0), 0);
  if (total <= 0) return { kind: "idle", detail: "no ambient weight" };

  let roll = Math.random() * total;
  for (const [type, weight] of entries) {
    roll -= Math.max(weight, 0);
    if (roll <= 0) {
      switch (type) {
        case "train":
          return { kind: "train", detail: "combat" };
        case "hunt":
          return { kind: "travel", detail: "nearest monster" };
        case "quest":
          return { kind: "idle", detail: "no quest available" };
      }
    }
  }
  return { kind: "idle", detail: "fallthrough" };
}

/**
 * Core decision function: directive queue takes priority; ambient weighting
 * is the fallback. Kept pure aside from starting a quest on the WorldState
 * it's passed (no separate I/O), so it's still cheaply unit testable.
 */
export function getNextAction(state: WorldState): Action {
  const active = state.directives[0];
  if (active) return actionForDirective(state, active);
  return ambientAction(state.weights);
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
