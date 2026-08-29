import type { WorldState } from "./state";
import { getNextAction, type Action } from "./decision";
import { progressActiveQuest } from "./quests";

const XP_PER_TRAIN_TICK = 5;
const XP_TO_LEVEL = (level: number) => level * 100;

function applyAction(state: WorldState, action: Action): void {
  switch (action.kind) {
    case "train": {
      const skillName = action.detail as keyof typeof state.toon.skills;
      const skill = state.toon.skills[skillName];
      if (!skill) break;
      skill.xp += XP_PER_TRAIN_TICK;
      const needed = XP_TO_LEVEL(skill.level);
      if (skill.xp >= needed) {
        skill.xp -= needed;
        skill.level += 1;
        state.log.push(`${state.toon.name} reached ${skillName} level ${skill.level}`);
      }
      break;
    }
    case "travel":
      state.log.push(`${state.toon.name} heads toward ${action.detail}`);
      break;
    case "fight":
      state.log.push(`${state.toon.name} fights at ${action.detail}`);
      break;
    case "quest":
      // The active quest was started (or already running) by the decision
      // layer; actually advancing it by one tick's worth of progress is the
      // tick loop's job, since directives can persist across many ticks.
      progressActiveQuest(state);
      // Once the quest completes, quests.ts clears activeQuest and pops it
      // off completedQuests -- pop the now-finished directive so the toon
      // falls back to ambient behavior instead of looping on a dead target.
      if (!state.toon.activeQuest && state.directives[0]?.type === "quest") {
        state.directives.shift();
      }
      break;
    case "idle":
      break;
  }
  // Cap log so it doesn't grow unbounded across a long session.
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

/**
 * Advances the world by exactly one tick: decide -> apply -> bump tick
 * counter. Pure mutation of the passed state, no timers/DOM here -- the
 * caller (UI or offline fast-forward) owns scheduling.
 */
export function step(state: WorldState): void {
  const action = getNextAction(state);
  applyAction(state, action);
  state.tick += 1;
}

/**
 * Runs `count` ticks in a row without any rendering in between -- used both
 * for offline catch-up simulation and for fast headless tests.
 */
export function runTicks(state: WorldState, count: number): void {
  for (let i = 0; i < count; i++) step(state);
}
