import type { WorldState, Directive, DirectiveType } from "./state";

/**
 * An Action is what the decision layer decides to do this tick. Kept as a
 * plain data object (not a function) so it's trivially loggable/testable.
 */
export interface Action {
  kind: "idle" | "train" | "travel" | "fight" | "turn_in_quest";
  detail: string;
}

/**
 * Tier B: directive queue. Pops the front directive if present and returns
 * an action working toward it. Falls back to null if no directive is active
 * or resolvable (caller should fall back to ambient/Tier A behavior).
 */
function actionForDirective(directive: Directive): Action {
  switch (directive.type) {
    case "train":
      return { kind: "train", detail: directive.target };
    case "hunt":
      return { kind: "travel", detail: directive.target };
    case "quest":
      return { kind: "turn_in_quest", detail: directive.target };
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
 * is the fallback. Kept pure (no mutation, no I/O) so it's cheaply unit
 * testable in isolation from the tick loop / UI.
 */
export function getNextAction(state: WorldState): Action {
  const active = state.directives[0];
  if (active) return actionForDirective(active);
  return ambientAction(state.weights);
}
