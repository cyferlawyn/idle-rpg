import type { WorldState, SkillName } from "./state";

export type QuestStepKind = "travel" | "kill" | "gather" | "deliver";

export interface QuestStep {
  kind: QuestStepKind;
  /** Zone for travel/kill steps, item name for gather/deliver steps. */
  target: string;
  /** Ticks/units of progress required to complete this step. */
  amount: number;
}

export interface QuestDefinition {
  id: string;
  title: string;
  /** Flavor text only -- per DESIGN.md, systems stay generic; faith/conversion
   * framing is a narrative skin on ordinary fetch/kill/deliver quests. */
  description: string;
  steps: QuestStep[];
  rewardXp: Partial<Record<SkillName, number>>;
  rewardPrayer: number;
  /**
   * Forward-compat per DESIGN.md "Epic arc vs side quests": lets a future
   * epic-arc quest declare it unlocks a new mechanic on completion, without
   * v0 needing to build any unlock-gating logic yet. Unused by side quests.
   */
  unlocksMechanic?: string;
  /** Epic (main story) vs side (fire-and-forget) -- narrative weight only. */
  weight: "epic" | "side";
}

// v0 side quests: lighthearted, low-stakes, content-mill quests per DESIGN.md.
// Flavor gestures at conversion/faith without any dedicated "convert" mechanic.
export const QUESTS: Record<string, QuestDefinition> = {
  "cat-in-tree": {
    id: "cat-in-tree",
    title: "The Cat in the Tree",
    description:
      "A child's cat is stuck up an old oak in the meadow. Rescuing it earns a " +
      "grateful family's quiet faith.",
    steps: [{ kind: "travel", target: "meadow", amount: 3 }],
    rewardXp: { woodcutting: 10 },
    rewardPrayer: 5,
    weight: "side",
  },
  "rat-basement": {
    id: "rat-basement",
    title: "Rat Infestation",
    description:
      "The tavern cellar is overrun with rats. Clearing them out wins the " +
      "innkeeper over to the faith.",
    steps: [
      { kind: "travel", target: "village", amount: 2 },
      { kind: "kill", target: "village-rat", amount: 5 },
    ],
    rewardXp: { combat: 20 },
    rewardPrayer: 10,
    weight: "side",
  },
  "wolf-pelts": {
    id: "wolf-pelts",
    title: "Wolf Pelts for the Tanner",
    description:
      "The village tanner needs wolf pelts from the forest -- good coin, " +
      "and a small nudge of gratitude toward the faith.",
    steps: [
      { kind: "travel", target: "forest", amount: 2 },
      { kind: "kill", target: "forest-wolf", amount: 4 },
    ],
    rewardXp: { combat: 22, woodcutting: 8 },
    rewardPrayer: 12,
    weight: "side",
  },
  "cave-clearing": {
    id: "cave-clearing",
    title: "Clear the Cave",
    description:
      "Something's been driving miners out of the eastern cave. Time to " +
      "find out what, and put a stop to it.",
    steps: [
      { kind: "travel", target: "cave", amount: 2 },
      { kind: "kill", target: "cave-spider", amount: 3 },
    ],
    rewardXp: { combat: 35 },
    rewardPrayer: 18,
    weight: "side",
  },
};

export function currentQuestStep(quest: QuestDefinition, stepIndex: number): QuestStep | undefined {
  return quest.steps[stepIndex];
}

/**
 * Advances the toon's active quest by one unit of progress toward its
 * current step, completing steps/quests and applying rewards as thresholds
 * are crossed. Pure mutation of WorldState, no I/O -- callable from the tick
 * loop the same way combat/training are.
 */
/**
 * Advances the toon's active quest. Travel-type steps advance by one unit
 * of tick-progress unconditionally (position/travel is already modeled as
 * real state per DESIGN.md). Kill-type steps only advance on a real kill
 * event matching the step's target monster -- previously this blindly
 * ticked forward regardless of step kind, meaning "kill 5 rats" completed
 * without any actual combat happening. Gather/deliver steps aren't
 * authored yet in v0 and keep the simple tick-progress fallback.
 */
export function progressActiveQuest(
  state: WorldState,
  killEvent?: { monsterId: string },
): void {
  const active = state.toon.activeQuest;
  if (!active) return;

  const quest = QUESTS[active.questId];
  if (!quest) return;

  const step = currentQuestStep(quest, active.stepIndex);
  if (!step) return;

  if (step.kind === "kill") {
    if (!killEvent || killEvent.monsterId !== step.target) return;
  }

  active.stepProgress += 1;

  if (active.stepProgress < step.amount) return;

  // Step complete -- advance to the next one, or finish the quest.
  if (active.stepIndex + 1 < quest.steps.length) {
    active.stepIndex += 1;
    active.stepProgress = 0;
    return;
  }

  completeQuest(state, quest);
}

function completeQuest(state: WorldState, quest: QuestDefinition): void {
  for (const [skillName, xp] of Object.entries(quest.rewardXp) as [SkillName, number][]) {
    state.toon.skills[skillName].xp += xp;
  }
  state.prayer += quest.rewardPrayer;
  state.toon.completedQuests.push(quest.id);
  state.toon.activeQuest = null;
  state.log.push(
    `${state.toon.name} completed "${quest.title}" (+${quest.rewardPrayer} prayer)`,
  );
}

/**
 * Starts a quest as the toon's active quest, if it exists and isn't already
 * completed/active. Used both by the directive queue (Tier B: "do quest X")
 * and, later, by any ambient auto-pickup behavior.
 */
export function startQuest(state: WorldState, questId: string): boolean {
  const quest = QUESTS[questId];
  if (!quest) return false;
  if (state.toon.completedQuests.includes(questId)) return false;
  if (state.toon.activeQuest?.questId === questId) return false;

  state.toon.activeQuest = { questId, stepIndex: 0, stepProgress: 0 };
  state.log.push(`${state.toon.name} begins "${quest.title}"`);
  return true;
}
