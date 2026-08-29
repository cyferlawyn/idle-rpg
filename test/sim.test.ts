import { describe, it, expect } from "vitest";
import { createInitialState } from "../src/sim/state";
import { getNextAction, issueDirective, DIRECTIVE_COST, HUNT_TRAVEL_TICKS } from "../src/sim/decision";
import { step, runTicks } from "../src/sim/tick";
import { startQuest, progressActiveQuest, QUESTS } from "../src/sim/quests";
import { startFight, resolveFightRound } from "../src/sim/combat";

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
    const action = getNextAction(state);
    // All pools start full and no quest is active/completed, so the
    // top-tier candidate set includes every skill, hunting, and both quests
    // -- just assert it picks *something* real rather than idling.
    expect(action.kind).not.toBe("idle");
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
    state.toon.completedQuests.push("cat-in-tree", "rat-basement");
    // Only stamina is forced empty here (energy/focus stay full) so
    // whatever ambient picks (train:gathering/crafting, since stamina-
    // gated hunt/train:combat are filtered out) never touches stamina --
    // isolates pure regen math without the toon needing to "rest".
    state.toon.pools.stamina.current = 0;
    runTicks(state, 10);
    expect(state.toon.pools.stamina.current).toBe(20);
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

describe("ambient variety (pool-priority picking)", () => {
  it("never picks an activity whose pool is already depleted", () => {
    const state = createInitialState();
    state.toon.pools.stamina.current = 0;
    for (let i = 0; i < 50; i++) {
      const action = getNextAction(state);
      if (action.kind === "train") expect(action.detail).not.toBe("combat");
      expect(action.kind).not.toBe("travel"); // hunting also drains stamina
    }
  });

  it("picks from every skill (not just combat) when pools are equally full", () => {
    const state = createInitialState();
    // Complete both quests so only the three trainable skills + hunting
    // remain as candidates -- isolates the skill-variety behavior.
    state.toon.completedQuests.push("cat-in-tree", "rat-basement");
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      state.ambientCommitment = null; // force a fresh roll each iteration --
      // this test is about scoring variety, stickiness is covered separately.
      const action = getNextAction(state);
      seen.add(action.kind === "train" ? `train:${action.detail}` : action.kind);
    }
    expect(seen.has("train:combat")).toBe(true);
    expect(seen.has("train:gathering")).toBe(true);
    expect(seen.has("train:crafting")).toBe(true);
    expect(seen.has("travel")).toBe(true);
  });

  it("rests when every pool is depleted and no quest is available", () => {
    const state = createInitialState();
    state.toon.pools.stamina.current = 0;
    state.toon.pools.energy.current = 0;
    state.toon.pools.focus.current = 0;
    state.toon.completedQuests.push("cat-in-tree", "rat-basement");
    const action = getNextAction(state);
    expect(action.kind).toBe("rest");
  });
});

describe("combat", () => {
  it("resolves a fight as a real sequence of rounds, not a single roll", () => {
    const state = createInitialState();
    startFight(state, "meadow-rat");
    expect(state.toon.activeFight?.monsterId).toBe("meadow-rat");
    const initialHp = state.toon.activeFight!.monsterHp;

    resolveFightRound(state);

    // Either still ongoing with reduced monster HP, or already resolved --
    // either way, exactly one round's worth of change happened, not a
    // single collapsed before/after delta with no visible steps.
    if (state.toon.activeFight) {
      expect(state.toon.activeFight.monsterHp).toBeLessThan(initialHp);
    }
  });

  it("awards XP, gold, and a kill credit on victory", () => {
    const state = createInitialState();
    // Combat level 5 makes the meadow rat go down fast and reliably.
    state.toon.skills.combat.level = 5;
    startFight(state, "meadow-rat");
    let rounds = 0;
    while (state.toon.activeFight && rounds < 20) {
      resolveFightRound(state);
      rounds++;
    }
    expect(state.toon.kills["meadow-rat"]).toBe(1);
    expect(state.toon.skills.combat.xp).toBeGreaterThan(0);
    expect(state.toon.gold).toBeGreaterThan(0);
  });

  it("flees instead of dying when HP drops critically low (no permadeath in v0)", () => {
    const state = createInitialState();
    state.toon.hp = 10; // near the flee threshold but with margin against max roll variance
    state.toon.maxHp = 20;
    startFight(state, "village-bandit"); // hits hard enough to trigger it
    let rounds = 0;
    while (state.toon.activeFight && rounds < 30) {
      resolveFightRound(state);
      rounds++;
    }
    expect(state.toon.hp).toBeGreaterThan(0); // never actually dies in v0
    expect(state.toon.activeFight).toBeNull(); // disengaged (fled or won)
  });

  it("kill-type quest steps only progress on a matching real kill, not blind ticks", () => {
    const state = createInitialState();
    state.toon.activeQuest = { questId: "rat-basement", stepIndex: 1, stepProgress: 0 };
    // Wrong monster: should not progress the "village-rat" kill step.
    progressActiveQuest(state, { monsterId: "meadow-rat" });
    expect(state.toon.activeQuest.stepProgress).toBe(0);
    // Right monster: should progress.
    progressActiveQuest(state, { monsterId: "village-rat" });
    expect(state.toon.activeQuest.stepProgress).toBe(1);
    // No kill event at all (e.g. a plain tick): should not progress either.
    progressActiveQuest(state);
    expect(state.toon.activeQuest.stepProgress).toBe(1);
  });

  it("hunting travels first, then engages a real fight once arrived (via the tick loop)", () => {
    const state = createInitialState();
    state.directives.push({ type: "hunt", target: "nearest monster", issuedAt: 0 });
    runTicks(state, HUNT_TRAVEL_TICKS);
    expect(state.toon.activeFight).not.toBeNull();
    // The fight starts this tick (as a side effect of arriving), so the
    // *next* tick's action/currentActivity is the one that reflects it.
    step(state);
    expect(state.currentActivity).toMatch(/Fighting/);
  });
});

describe("ambient stickiness (commits to one pick, does not thrash)", () => {
  it("sticks to the same quest across ticks instead of restarting a different one every tick", () => {
    const state = createInitialState();
    // Deplete every pool-gated candidate so only quests remain -- this is
    // exactly the reported bug scenario: once combat's pool ran out, the
    // toon flickered between "start quest A" and "start quest B" every
    // single tick, discarding whatever progress had just been made.
    state.toon.pools.stamina.current = 0;
    state.toon.pools.energy.current = 0;
    state.toon.pools.focus.current = 0;

    step(state); // step() calls getNextAction internally, then acts on it
    let pick = state.toon.activeQuest?.questId;
    expect(pick).toBeDefined();

    for (let i = 0; i < 20; i++) {
      const before = state.toon.activeQuest?.questId;
      step(state);
      const after = state.toon.activeQuest?.questId;
      // A quest is allowed to change only across a *completion* boundary
      // (before was active, now cleared/different because it finished and
      // ambient re-rolled) -- it must never flip while still in progress.
      if (before && after && before !== after) {
        throw new Error(`quest changed from ${before} to ${after} while still active`);
      }
    }
  });

  it("drops a stale commitment and re-rolls once it's no longer valid (e.g. quest completed)", () => {
    const state = createInitialState();
    state.toon.pools.stamina.current = 0;
    state.toon.pools.energy.current = 0;
    state.toon.pools.focus.current = 0;

    step(state);
    const firstPick = state.toon.activeQuest?.questId;
    expect(firstPick).toBeDefined();

    // Simulate the committed quest finishing.
    state.toon.completedQuests.push(firstPick as string);
    state.toon.activeQuest = null;

    const action = getNextAction(state);
    if (action.kind === "quest") {
      expect(action.detail).not.toBe(firstPick);
    }
  });

  it("resumes travel-then-fight correctly even while committed to hunting ambiently", () => {
    const state = createInitialState();
    state.toon.pools.energy.current = 0;
    state.toon.pools.focus.current = 0;
    state.toon.completedQuests.push("cat-in-tree", "rat-basement");
    // Force the commitment deterministically to hunt (train:combat also
    // ties on full stamina, so an unforced roll could pick that instead).
    state.ambientCommitment = { kind: "hunt" };

    runTicks(state, HUNT_TRAVEL_TICKS + 1);
    // Ambient stayed committed to "hunt" the whole time, and hunt's own
    // internal state machine (travel -> fight) still progressed normally
    // instead of getting stuck re-rolling "travel" forever.
    expect(state.toon.activeFight).not.toBeNull();
  });
});

describe("quest kill-steps actually route through combat (not stalled)", () => {
  it("a quest sitting on a kill step routes into real hunting instead of doing nothing every tick", () => {
    const state = createInitialState();
    // Advance Rat Infestation past its travel step directly onto its kill
    // step -- this reproduces the reported bug: the toon shows "Questing:
    // Rat Infestation" for many ticks with zero stat/gold/kill progress,
    // because the decision layer returned a flat "quest" action that did
    // nothing once the step wasn't a travel step.
    state.directives.push({ type: "quest", target: "rat-basement", issuedAt: 0 });
    step(state); // starts the quest
    state.toon.activeQuest!.stepIndex = 1; // jump to the kill step
    state.toon.activeQuest!.stepProgress = 0;

    step(state);
    // Must be actually hunting (traveling or fighting), not a no-op
    // "quest" action that never engages a monster.
    expect(["travel", "fight"]).toContain(getActionKindFromActivity(state.currentActivity));
  });

  it("kills earned while on a quest's kill step actually progress the quest", () => {
    const state = createInitialState();
    state.directives.push({ type: "quest", target: "rat-basement", issuedAt: 0 });
    step(state);
    state.toon.activeQuest!.stepIndex = 1;
    state.toon.activeQuest!.stepProgress = 0;

    // Run enough ticks to travel to the monster and land several kills --
    // generous budget since combat has randomness (variable rounds/kill).
    runTicks(state, 60);

    expect(state.toon.kills["village-rat"]).toBeGreaterThan(0);
    expect(state.toon.activeQuest?.stepProgress ?? 5).toBeGreaterThan(0);
  });
});

/** Best-effort mapping from the human-readable activity string back to a
 * rough action kind, since currentActivity is what's asserted on above. */
function getActionKindFromActivity(activity: string): string {
  if (activity.startsWith("Traveling")) return "travel";
  if (activity.startsWith("Fighting")) return "fight";
  if (activity.startsWith("Questing")) return "quest";
  return activity.toLowerCase();
}
