import { describe, it, expect } from "vitest";
import { createInitialState } from "../src/sim/state";
import { getNextAction, issueDirective, DIRECTIVE_COST } from "../src/sim/decision";
import { step, runTicks } from "../src/sim/tick";
import { startQuest, progressActiveQuest, QUESTS } from "../src/sim/quests";

describe("decision layer", () => {
  it("follows an active directive over ambient weighting", () => {
    const state = createInitialState();
    state.directives.push({ type: "train", target: "gathering", issuedAt: 0 });
    const action = getNextAction(state);
    expect(action.kind).toBe("train");
    expect(action.detail).toBe("gathering");
  });

  it("falls back to ambient action when no directive is queued", () => {
    const state = createInitialState();
    state.weights = { quest: 0, hunt: 0, train: 1 };
    const action = getNextAction(state);
    expect(action.kind).toBe("train");
  });

  it("starts the target quest when a quest directive is active", () => {
    const state = createInitialState();
    state.directives.push({ type: "quest", target: "cat-in-tree", issuedAt: 0 });
    const action = getNextAction(state);
    expect(action.kind).toBe("quest");
    expect(state.toon.activeQuest?.questId).toBe("cat-in-tree");
  });
});

describe("prayer / directive cost", () => {
  it("refuses to issue a directive without enough prayer", () => {
    const state = createInitialState();
    state.prayer = 0;
    const ok = issueDirective(state, "quest", "cat-in-tree");
    expect(ok).toBe(false);
    expect(state.directives.length).toBe(0);
  });

  it("spends prayer and queues the directive when affordable", () => {
    const state = createInitialState();
    state.prayer = 10;
    const ok = issueDirective(state, "quest", "cat-in-tree");
    expect(ok).toBe(true);
    expect(state.prayer).toBe(10 - DIRECTIVE_COST.quest);
    expect(state.directives[0]).toMatchObject({ type: "quest", target: "cat-in-tree" });
  });
});

describe("tick loop", () => {
  it("advances the tick counter", () => {
    const state = createInitialState();
    step(state);
    expect(state.tick).toBe(1);
  });

  it("levels up a trained skill after enough ticks", () => {
    const state = createInitialState();
    state.directives.push({ type: "train", target: "combat", issuedAt: 0 });
    // level 1 -> 2 needs 100 xp at 5xp/tick = 20 ticks
    runTicks(state, 20);
    expect(state.toon.skills.combat.level).toBe(2);
  });

  it("caps the log so it does not grow unbounded", () => {
    const state = createInitialState();
    state.directives.push({ type: "train", target: "combat", issuedAt: 0 });
    runTicks(state, 500);
    expect(state.log.length).toBeLessThanOrEqual(200);
  });

  it("sets a human-readable currentActivity describing the resolved action", () => {
    const state = createInitialState();
    state.directives.push({ type: "quest", target: "cat-in-tree", issuedAt: 0 });
    step(state);
    expect(state.currentActivity).toBe("Questing: The Cat in the Tree");

    const trainState = createInitialState();
    trainState.directives.push({ type: "train", target: "combat", issuedAt: 0 });
    step(trainState);
    expect(trainState.currentActivity).toBe("Training combat");
  });

  it("completes a quest end to end via the directive queue, rewarding prayer", () => {
    const state = createInitialState();
    const quest = QUESTS["cat-in-tree"];
    const totalSteps = quest.steps.reduce((sum, s) => sum + s.amount, 0);

    state.directives.push({ type: "quest", target: "cat-in-tree", issuedAt: 0 });
    runTicks(state, totalSteps);

    expect(state.toon.completedQuests).toContain("cat-in-tree");
    expect(state.toon.activeQuest).toBeNull();
    expect(state.prayer).toBe(quest.rewardPrayer);
    // Directive should be popped once its quest completes, falling back to
    // ambient behavior rather than looping on a finished target.
    expect(state.directives.length).toBe(0);
  });

  it("does not restart an already-completed quest", () => {
    const state = createInitialState();
    state.toon.completedQuests.push("cat-in-tree");
    const started = startQuest(state, "cat-in-tree");
    expect(started).toBe(false);
    expect(state.toon.activeQuest).toBeNull();
  });
});

describe("quests data", () => {
  it("progressActiveQuest is a no-op with no active quest", () => {
    const state = createInitialState();
    expect(() => progressActiveQuest(state)).not.toThrow();
    expect(state.toon.activeQuest).toBeNull();
  });
});
