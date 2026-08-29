import type { WorldState, PoolName } from "./state";
import { getNextAction, type Action } from "./decision";
import { progressActiveQuest, startQuest, QUESTS } from "./quests";
import { SKILL_POOL, drainPool, regenIdlePools, isPoolDepleted } from "./pools";
import { pickMonster, startFight, resolveFightRound, regenHp } from "./combat";
import { MONSTERS } from "./monsters";
import { travelTicksBetween } from "./zones";
import { HUNT_TRAVEL_TICKS } from "./decision";

const XP_PER_TRAIN_TICK = 5;
const XP_TO_LEVEL = (level: number) => level * 100;

/** Which pool (if any) an action draws down while it's being performed. */
function poolForAction(action: Action): PoolName | null {
  switch (action.kind) {
    case "train":
      return SKILL_POOL[action.detail as keyof typeof SKILL_POOL] ?? null;
    case "fight":
      return "stamina";
    default:
      // travel/quest/idle don't drain a pool directly yet -- quests will
      // once real combat/gathering steps exist; tracked as a TODO rather
      // than over-building ahead of that (see DESIGN.md open questions).
      return null;
  }
}

function describeActivity(action: Action): string {
  switch (action.kind) {
    case "train":
      return `Training ${action.detail}`;
    case "travel":
      return `Traveling to ${action.detail}`;
    case "fight": {
      const monster = MONSTERS[action.detail];
      return `Fighting ${monster?.name ?? action.detail}`;
    }
    case "quest": {
      const quest = QUESTS[action.detail];
      return `Questing: ${quest?.title ?? action.detail}`;
    }
    case "idle":
      return "Idle";
    case "rest":
      return "Resting";
  }
}

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
    case "travel": {
      // Real position/travel state, not an instant teleport (DESIGN.md
      // constraint) -- advance ticksRemaining; once it hits 0, land in the
      // destination zone and either engage combat (hunt) or just arrive
      // (settle -- training/questing picks it up naturally next tick).
      const destination = action.detail;
      if (!state.toon.travel || state.toon.travel.to !== destination) {
        const sameZone = destination === state.toon.zone;
        const totalTicks = sameZone ? HUNT_TRAVEL_TICKS : travelTicksBetween(state.toon.zone, destination);
        state.toon.travel = {
          from: state.toon.zone,
          to: destination,
          ticksRemaining: totalTicks,
          totalTicks,
        };
        state.log.push(`${state.toon.name} heads toward ${destination}`);
      }
      state.toon.travel.ticksRemaining -= 1;
      if (state.toon.travel.ticksRemaining <= 0) {
        state.toon.zone = destination;
        state.toon.travel = null;
        if (action.travelPurpose === "hunt") {
          const monsterId = pickMonster(state);
          if (monsterId) startFight(state, monsterId);
          else state.log.push(`${state.toon.name} finds no monsters here`);
        } else {
          state.log.push(`${state.toon.name} arrives at ${destination}`);
        }
      }
      break;
    }
    case "fight": {
      const monsterId = state.toon.activeFight?.monsterId;
      const result = resolveFightRound(state);
      if (result === "kill" && monsterId) {
        progressActiveQuest(state, { monsterId });
      }
      break;
    }
    case "quest":
      // Ambient picks and directive-driven picks both land here; start the
      // quest if it isn't already the active one (startQuest is a safe
      // no-op if it's already running or completed).
      if (state.toon.activeQuest?.questId !== action.detail) {
        startQuest(state, action.detail);
      }
      progressActiveQuest(state);
      // Once the quest completes, quests.ts clears activeQuest and pops it
      // off completedQuests -- pop the now-finished directive so the toon
      // falls back to ambient behavior instead of looping on a dead target.
      if (!state.toon.activeQuest && state.directives[0]?.type === "quest") {
        state.directives.shift();
      }
      break;
    case "idle":
    case "rest":
      break;
  }
  // Cap log so it doesn't grow unbounded across a long session.
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

/**
 * Advances the world by exactly one tick.
 *
 * Order: decide -> check the relevant pool isn't already depleted (if it is,
 * the toon rests instead this tick, and a generic directive at the front of
 * the queue is consumed rather than left immortal) -> apply -> drain the
 * active pool / regen the rest -> bump tick counter.
 *
 * Quest directives are the deliberate exception: per design, a quest stays
 * at the top of the priority list even while its pool recovers (the toon
 * might do something else -- gather, rest -- in between) rather than being
 * abandoned like a generic train/hunt directive would be.
 */
export function step(state: WorldState): void {
  let action = getNextAction(state);
  const pool = poolForAction(action);

  if (pool && isPoolDepleted(state, pool)) {
    const isQuestDirective = state.directives[0]?.type === "quest";
    if (!isQuestDirective && state.directives[0]) {
      // Generic directive (train/hunt): consumed on depletion rather than
      // left running forever -- this is the fix for the "toon trains combat
      // forever and never responds to a new nudge" bug: previously nothing
      // ever popped a non-quest directive off the queue.
      state.directives.shift();
      state.log.push(`${state.toon.name} is too exhausted to continue and stops`);
    }
    action = { kind: "rest", detail: pool };
  }

  applyAction(state, action);

  const activePool = poolForAction(action);
  if (activePool) drainPool(state, activePool);
  regenIdlePools(state, activePool);
  regenHp(state);

  state.currentActivity = describeActivity(action);
  state.tick += 1;
}

/**
 * Runs `count` ticks in a row without any rendering in between -- used both
 * for offline catch-up simulation and for fast headless tests.
 */
export function runTicks(state: WorldState, count: number): void {
  for (let i = 0; i < count; i++) step(state);
}
