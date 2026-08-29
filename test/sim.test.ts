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

describe("resource pools / stickiness", () => {
  it("drains the relevant pool while training and regenerates the others", () => {
    const state = createInitialState();
    state.directives.push({ type: "train", target: "combat", issuedAt: 0 });
    step(state);
    // combat training drains stamina...
    expect(state.toon.pools.stamina.current).toBeLessThan(100);
    // ...and regenerates the pools not in use (already at max, so unchanged,
    // but exercises the non-active-pool regen path without erroring/over-capping).
    expect(state.toon.pools.energy.current).toBe(100);
    expect(state.toon.pools.focus.current).toBe(100);
  });

  it("consumes a generic (train) directive once its pool is depleted, unlike the old immortal-directive bug", () => {
    const state = createInitialState();
    state.directives.push({ type: "train", target: "combat", issuedAt: 0 });
    // stamina starts at 100, drains 4/tick -> hits 0 exactly at tick 25;
    // tick 26 detects the depletion, consumes the directive, and rests
    // (which also regens the now-idle stamina pool by 2 that same tick).
    runTicks(state, 26);
    expect(state.toon.pools.stamina.current).toBe(2);
    // The directive must be gone -- this is the fix for the reported bug
    // where a generic directive ran forever and blocked new nudges.
    expect(state.directives.length).toBe(0);
    expect(state.currentActivity).toBe("Resting");
  });

  it("regenerates a depleted pool over time once the toon stops that activity", () => {
    const state = createInitialState();
    state.directives.push({ type: "train", target: "combat", issuedAt: 0 });
    runTicks(state, 26); // depletes stamina, directive consumed, toon rests (regens +2 same tick)
    expect(state.toon.pools.stamina.current).toBe(2);
    // Force pure idle (no ambient re-pick of train) so this test is
    // deterministic rather than dependent on the random ambient roll.
    state.weights = { quest: 0, hunt: 0, train: 0 };
    runTicks(state, 10);
    expect(state.toon.pools.stamina.current).toBe(22);
  });

  it("keeps a quest directive at the front even if its pool depletes (does not abandon it)", () => {
    const state = createInitialState();
    state.directives.push({ type: "quest", target: "cat-in-tree", issuedAt: 0 });
    // cat-in-tree is travel-only and completes in 3 ticks -- check mid-quest
    // (before completion) that it isn't abandoned due to any pool logic.
    runTicks(state, 2);
    expect(state.toon.activeQuest).not.toBeNull();
  });

  it("a fresh nudge can now take over after the bootstrap train directive is consumed", () => {
    const state = createInitialState();
    state.prayer = 10;
    state.directives.push({ type: "train", target: "combat", issuedAt: 0 });
    runTicks(state, 26); // consumes the train directive via exhaustion
    const ok = issueDirective(state, "quest", "cat-in-tree");
    expect(ok).toBe(true);
    const action = getNextAction(state);
    expect(action.kind).toBe("quest");
  });
});

describe("quests data", () => {
  it("progressActiveQuest is a no-op with no active quest", () => {
    const state = createInitialState();
    expect(() => progressActiveQuest(state)).not.toThrow();
    expect(state.toon.activeQuest).toBeNull();
  });
});
