import { describe, it, expect } from "vitest";
import { createInitialState } from "../src/sim/state";
import { getNextAction, issueDirective, DIRECTIVE_COST, HUNT_TRAVEL_TICKS } from "../src/sim/decision";
import { step, runTicks } from "../src/sim/tick";
import { startQuest, progressActiveQuest, QUESTS } from "../src/sim/quests";
import { startFight, resolveFightRound, isCollapsed, regenHp } from "../src/sim/combat";
import { movementSpeedMultiplier } from "../src/sim/zones";
import { saveState, loadState, type StorageLike } from "../src/sim/storage";

function createMemStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe("decision layer", () => {
  it("follows an active directive over ambient weighting", () => {
    const state = createInitialState();
    state.directives.push({ type: "train", target: "woodcutting", issuedAt: 0 });
    const action = getNextAction(state);
    // Woodcutting trains at the forest (see sim/zones.ts); the toon starts
    // in the meadow, so the directive resolves to travel there first --
    // it's still "following the directive," just via the walk step.
    expect(action.kind).toBe("travel");
    expect(action.detail).toBe("forest");
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
    // Isolate leveling math from stamina depletion (a separate mechanic) --
    // give it a deep pool so the full run below is uninterrupted training.
    state.toon.pools.stamina.current = 1_000_000;
    // level 1 -> 2 needs round(83*1^2+100) = 183 xp at 5xp/tick = 37 ticks
    runTicks(state, 37);
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
    state.toon.completedQuests.push("cat-in-tree", "rat-basement", "wolf-pelts", "cave-clearing");
    // Only stamina is forced empty here (energy/focus/vitality/nerve stay
    // full) so whatever ambient picks (train:fishing/cooking/smithing/
    // alchemy/thieving, since stamina-gated hunt/train:combat/woodcutting/
    // mining are filtered out) never touches stamina -- isolates pure
    // regen math without the toon needing to "rest".
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
    // Complete both quests so only the eight trainable skills + hunting
    // remain as candidates -- isolates the skill-variety behavior. Skills
    // other than combat require walking to a different zone first (see
    // sim/zones.ts), so check the *committed intent* rather than the
    // resolved action -- a "go train woodcutting" pick correctly resolves
    // to a "travel" action while the toon is still in the meadow.
    state.toon.completedQuests.push("cat-in-tree", "rat-basement", "wolf-pelts", "cave-clearing");
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      state.ambientCommitment = null; // force a fresh roll each iteration --
      // this test is about scoring variety, stickiness is covered separately.
      getNextAction(state);
      const intent = state.ambientCommitment as { kind: string; skill?: string } | null;
      seen.add(intent?.kind === "train" ? `train:${intent.skill}` : (intent?.kind ?? "none"));
    }
    expect(seen.has("train:combat")).toBe(true);
    expect(seen.has("train:woodcutting")).toBe(true);
    expect(seen.has("train:mining")).toBe(true);
    expect(seen.has("train:fishing")).toBe(true);
    expect(seen.has("train:cooking")).toBe(true);
    expect(seen.has("train:smithing")).toBe(true);
    expect(seen.has("train:alchemy")).toBe(true);
    expect(seen.has("train:thieving")).toBe(true);
    expect(seen.has("hunt")).toBe(true);
  });

  it("rests when every pool is depleted and no quest is available", () => {
    const state = createInitialState();
    state.toon.pools.stamina.current = 0;
    state.toon.pools.energy.current = 0;
    state.toon.pools.focus.current = 0;
    state.toon.pools.vitality.current = 0;
    state.toon.pools.nerve.current = 0;
    state.toon.pools.fatigue.current = 0;
    state.toon.pools.concentration.current = 0;
    state.toon.completedQuests.push("cat-in-tree", "rat-basement", "wolf-pelts", "cave-clearing");
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

    // Either still ongoing with reduced-or-equal monster HP (a miss keeps
    // HP unchanged that round), or already resolved -- either way, exactly
    // one round's worth of change happened, not a single collapsed
    // before/after delta with no visible steps. A real per-round event was
    // recorded either way (hit/miss/block/kill), proving rounds are real.
    if (state.toon.activeFight) {
      expect(state.toon.activeFight.monsterHp).toBeLessThanOrEqual(initialHp);
      expect(state.toon.activeFight.events.length).toBeGreaterThan(0);
    }
  });

  it("records distinct hit/miss/block event kinds and caps the ring buffer (task t_d4d53058)", () => {
    const state = createInitialState();
    startFight(state, "meadow-rat");
    for (let i = 0; i < 60 && state.toon.activeFight; i++) {
      resolveFightRound(state);
    }
    // Fight either ran to completion or hit the cap -- either way, if it's
    // still ongoing, the ring buffer must never exceed MAX_FIGHT_EVENTS.
    if (state.toon.activeFight) {
      expect(state.toon.activeFight.events.length).toBeLessThanOrEqual(30);
      const kinds = new Set(state.toon.activeFight.events.map((e) => e.kind));
      // Over 60 rounds we should see real variety, not just "hit" forever.
      expect(kinds.size).toBeGreaterThan(1);
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
    state.toon.pools.vitality.current = 0;
    state.toon.pools.nerve.current = 0;
    state.toon.pools.fatigue.current = 0;
    state.toon.pools.concentration.current = 0;

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
    state.toon.pools.vitality.current = 0;
    state.toon.pools.nerve.current = 0;
    // Also deplete fatigue/concentration (gathering/crafting's exhaustion
    // pools, added after this test was written) so only quests remain as
    // valid top-tier candidates -- otherwise woodcutting/cooking/etc. tie
    // with quests at full score and firstPick isn't reliably a quest.
    state.toon.pools.fatigue.current = 0;
    state.toon.pools.concentration.current = 0;

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
    state.toon.completedQuests.push("cat-in-tree", "rat-basement", "wolf-pelts", "cave-clearing");
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
    // generous budget since combat has randomness (variable rounds/kill),
    // and a fled/hurt toon now rests to recover HP before re-engaging
    // (see combat.ts RECOVERED_HP_FRACTION) rather than instantly retrying.
    // Note: with several quests now available, ambient behavior may pick
    // up a *new* quest once rat-basement completes within this budget, so
    // assert on the kill count and completion, not on activeQuest still
    // pointing at rat-basement's own stepProgress.
    runTicks(state, 200);

    expect(state.toon.kills["village-rat"]).toBeGreaterThan(0);
    expect(state.toon.completedQuests).toContain("rat-basement");
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

describe("gathering exhaustion (fatigue pool)", () => {
  it("depletes fatigue while a gathering skill (woodcutting) is trained", () => {
    const state = createInitialState();
    state.toon.zone = "forest"; // skip travel, isolate training/drain
    state.directives.push({ type: "train", target: "woodcutting", issuedAt: 0 });
    step(state);
    expect(state.toon.pools.fatigue.current).toBeLessThan(100);
  });

  it("stops the gathering activity at 0 fatigue (no random reassignment, falls to rest)", () => {
    const state = createInitialState();
    state.toon.zone = "forest";
    state.directives.push({ type: "train", target: "woodcutting", issuedAt: 0 });
    state.toon.pools.fatigue.current = 0.5; // one drain tick (0.5/tick) from empty
    step(state); // drains to 0
    step(state); // detects depletion, consumes directive, rests (regens +0.5)
    expect(state.toon.pools.fatigue.current).toBe(0.5);
    expect(state.directives.length).toBe(0);
    expect(state.currentActivity).toBe("Resting");
  });

  it("clamps fatigue at exactly 0 and does not re-fire termination every tick while at 0", () => {
    const state = createInitialState();
    state.toon.zone = "mountain";
    state.directives.push({ type: "train", target: "mining", issuedAt: 0 });
    state.toon.pools.fatigue.current = 0.5;
    step(state); // depletes to exactly 0
    expect(state.toon.pools.fatigue.current).toBe(0);
    step(state); // depletion detected, directive consumed, toon rests (regens once)
    expect(state.directives.length).toBe(0);
    expect(state.currentActivity).toBe("Resting");
    // Running further ticks while resting must never go negative or throw,
    // and must not re-consume an (already-empty) directive queue.
    runTicks(state, 5);
    expect(state.toon.pools.fatigue.current).toBeGreaterThanOrEqual(0);
  });

  it("recovers fatigue during rest/other activities once gathering stops", () => {
    const state = createInitialState();
    state.toon.pools.fatigue.current = 0;
    // Complete all quests and drain every other pool-gated candidate so
    // ambient mode has nothing to do but rest -- isolates pure fatigue
    // regen math, same pattern as the existing stamina regen test.
    state.toon.completedQuests.push("cat-in-tree", "rat-basement", "wolf-pelts", "cave-clearing");
    state.toon.pools.stamina.current = 0;
    state.toon.pools.energy.current = 0;
    state.toon.pools.focus.current = 0;
    state.toon.pools.vitality.current = 0;
    state.toon.pools.nerve.current = 0;
    runTicks(state, 10);
    expect(state.toon.pools.fatigue.current).toBeCloseTo(5, 5); // 0.5/tick * 10
  });

  it("thieving also drains the shared fatigue pool (folded in per spec)", () => {
    const state = createInitialState();
    state.toon.zone = "village"; // thieving trains in the village market
    state.directives.push({ type: "train", target: "thieving", issuedAt: 0 });
    step(state);
    expect(state.toon.pools.fatigue.current).toBeLessThan(100);
  });
});

describe("crafting exhaustion (concentration pool)", () => {
  it("depletes concentration while a crafting skill (cooking) is trained", () => {
    const state = createInitialState();
    state.toon.zone = "village"; // skip travel, isolate training/drain
    state.directives.push({ type: "train", target: "cooking", issuedAt: 0 });
    step(state);
    expect(state.toon.pools.concentration.current).toBeLessThan(100);
  });

  it("stops the crafting activity at 0 concentration (no random reassignment, falls to rest)", () => {
    const state = createInitialState();
    state.toon.zone = "village";
    state.directives.push({ type: "train", target: "cooking", issuedAt: 0 });
    state.toon.pools.concentration.current = 0.5; // one drain tick (0.5/tick) from empty
    step(state); // drains to 0
    step(state); // detects depletion, consumes directive, rests (regens +0.5)
    expect(state.toon.pools.concentration.current).toBe(0.5);
    expect(state.directives.length).toBe(0);
    expect(state.currentActivity).toBe("Resting");
  });

  it("clamps concentration at exactly 0 and does not re-fire termination every tick while at 0", () => {
    const state = createInitialState();
    state.toon.zone = "cave";
    state.directives.push({ type: "train", target: "alchemy", issuedAt: 0 });
    state.toon.pools.concentration.current = 0.5;
    step(state); // depletes to exactly 0
    expect(state.toon.pools.concentration.current).toBe(0);
    step(state); // depletion detected, directive consumed, toon rests (regens once)
    expect(state.directives.length).toBe(0);
    expect(state.currentActivity).toBe("Resting");
    // Running further ticks while resting must never go negative or throw,
    // and must not re-consume an (already-empty) directive queue.
    runTicks(state, 5);
    expect(state.toon.pools.concentration.current).toBeGreaterThanOrEqual(0);
  });

  it("recovers concentration during rest/other activities once crafting stops", () => {
    const state = createInitialState();
    state.toon.pools.concentration.current = 0;
    // Complete all quests and drain every other pool-gated candidate so
    // ambient mode has nothing to do but rest -- isolates pure concentration
    // regen math, same pattern as the existing fatigue regen test.
    state.toon.completedQuests.push("cat-in-tree", "rat-basement", "wolf-pelts", "cave-clearing");
    state.toon.pools.stamina.current = 0;
    state.toon.pools.energy.current = 0;
    state.toon.pools.focus.current = 0;
    state.toon.pools.vitality.current = 0;
    state.toon.pools.nerve.current = 0;
    state.toon.pools.fatigue.current = 0;
    runTicks(state, 10);
    expect(state.toon.pools.concentration.current).toBeCloseTo(5, 5); // 0.5/tick * 10
  });

  it("smithing also drains the shared concentration pool", () => {
    const state = createInitialState();
    state.toon.zone = "village"; // smithing trains in the village too
    state.directives.push({ type: "train", target: "smithing", issuedAt: 0 });
    step(state);
    expect(state.toon.pools.concentration.current).toBeLessThan(100);
  });

  it("is not touched by non-crafting activities (regenIdlePools leaves it capped at max while unused)", () => {
    const state = createInitialState();
    state.directives.push({ type: "train", target: "combat", issuedAt: 0 });
    step(state);
    expect(state.toon.pools.concentration.current).toBe(100);
  });
});

describe("combat exhaustion (HP) pool", () => {
  it("HP depletes from combat damage down to exactly 0, clamped (never negative)", () => {
    const state = createInitialState();
    state.toon.hp = 3;
    state.toon.maxHp = 20;
    startFight(state, "village-bandit"); // hits hard enough to zero out fast
    let rounds = 0;
    let result: ReturnType<typeof resolveFightRound> = "ongoing";
    while (state.toon.activeFight && rounds < 30) {
      result = resolveFightRound(state);
      rounds++;
    }
    expect(state.toon.hp).toBeGreaterThanOrEqual(0);
    if (result === "collapse") {
      expect(state.toon.hp).toBe(0);
    }
  });

  it("forces combat to stop immediately at 0 HP (isCollapsed true, activeFight cleared)", () => {
    const state = createInitialState();
    state.toon.hp = 1;
    state.toon.maxHp = 20;
    startFight(state, "village-bandit");
    let result: ReturnType<typeof resolveFightRound> = "ongoing";
    let rounds = 0;
    while (state.toon.activeFight && rounds < 30) {
      result = resolveFightRound(state);
      rounds++;
    }
    // village-bandit hits hard enough that starting at 1 HP with no floor
    // reliably ends in collapse well before the 30-round budget.
    expect(["collapse", "kill"]).toContain(result);
    if (result === "collapse") {
      expect(isCollapsed(state)).toBe(true);
      expect(state.toon.activeFight).toBeNull();
    }
  });

  it("does not re-fire collapse repeatedly once HP sits at 0 (fires exactly once per fight)", () => {
    const state = createInitialState();
    state.toon.hp = 1;
    state.toon.maxHp = 20;
    startFight(state, "village-bandit");
    const results: string[] = [];
    let rounds = 0;
    while (state.toon.activeFight && rounds < 30) {
      results.push(resolveFightRound(state));
      rounds++;
    }
    // "collapse" (like "kill") clears activeFight, so it can only appear
    // once -- resolveFightRound becomes a no-op ("ongoing") once the fight
    // is already over.
    expect(results.filter((r) => r === "collapse").length).toBeLessThanOrEqual(1);
  });

  it("at HP collapse, tick.ts randomly reassigns to a non-combat activity and excludes hunt/train:combat", () => {
    const state = createInitialState();
    state.toon.hp = 1;
    state.toon.maxHp = 20;
    state.directives.push({ type: "hunt", target: "nearest monster", issuedAt: 0 });
    state.toon.activeFight = { monsterId: "village-bandit", monsterHp: 1000, events: [], turn: 0 };
    // Force a collapse deterministically via direct tick invocation isn't
    // exposed, so drive it through the real fight loop via runTicks/step,
    // asserting the resulting ambient commitment (if any) never points back
    // at combat.
    let collapsed = false;
    for (let i = 0; i < 30 && !collapsed; i++) {
      step(state);
      if (state.toon.hp <= 0) collapsed = true;
    }
    if (collapsed) {
      expect(state.toon.activeFight).toBeNull();
      const intent = state.ambientCommitment as { kind: string; skill?: string } | null;
      if (intent) {
        expect(intent.kind).not.toBe("hunt");
        if (intent.kind === "train") expect(intent.skill).not.toBe("combat");
      }
    }
  });

  it("HP slowly regenerates while not in combat (regenHp), capped at maxHp", () => {
    const state = createInitialState();
    state.toon.hp = 0;
    state.toon.maxHp = 20;
    state.toon.activeFight = null;
    regenHp(state);
    expect(state.toon.hp).toBeGreaterThan(0);
    expect(state.toon.hp).toBeLessThanOrEqual(state.toon.maxHp);

    // Doesn't regen while actively fighting.
    const fighting = createInitialState();
    fighting.toon.hp = 5;
    fighting.toon.activeFight = { monsterId: "village-bandit", monsterHp: 100, events: [], turn: 0 };
    regenHp(fighting);
    expect(fighting.toon.hp).toBe(5);

    // Caps at maxHp, doesn't overshoot.
    const nearFull = createInitialState();
    nearFull.toon.hp = nearFull.toon.maxHp;
    nearFull.toon.activeFight = null;
    regenHp(nearFull);
    expect(nearFull.toon.hp).toBe(nearFull.toon.maxHp);
  });

  it("recovers over many idle ticks after a collapse, eventually able to re-engage combat", () => {
    const state = createInitialState();
    state.toon.hp = 0;
    state.toon.maxHp = 20;
    state.toon.activeFight = null;
    for (let i = 0; i < 25; i++) {
      regenHp(state);
    }
    expect(state.toon.hp).toBeGreaterThan(0);
  });
});

describe("agility passive training and persistence", () => {
  it("movementSpeedMultiplier matches spec: 1.0 at L1, discounted mid-level, capped at 0.3", () => {
    expect(movementSpeedMultiplier(1)).toBeCloseTo(1.0);
    expect(movementSpeedMultiplier(6)).toBeCloseTo(0.85); // 5 levels above 1 * 3% = 15% off
    expect(movementSpeedMultiplier(25)).toBeCloseTo(0.3); // cap reached (~L24+)
    expect(movementSpeedMultiplier(100)).toBeCloseTo(0.3); // never below floor
  });

  it("grants passive Agility XP and levels up purely from repeated travel, no train directive", () => {
    const state = createInitialState();
    expect(state.toon.skills.agility.level).toBe(1);
    expect(state.toon.distanceMoved).toBe(0);

    // Force continuous back-and-forth travel by alternating between two
    // skills whose training zones differ (woodcutting=forest,
    // fishing=lake) -- every time the toon settles into one zone, flip
    // the directive to the other so it's always mid-trip, simulating
    // "moving around the Overworld" over a long session.
    let usingForest = true;
    for (let i = 0; i < 4000; i++) {
      state.directives.length = 0;
      state.directives.push({
        type: "train",
        target: usingForest ? "woodcutting" : "fishing",
        issuedAt: state.tick,
      });
      step(state);
      if (!state.toon.travel && state.toon.zone === (usingForest ? "forest" : "lake")) {
        usingForest = !usingForest;
      }
    }

    expect(state.toon.distanceMoved).toBeGreaterThan(0);
    expect(state.toon.skills.agility.level).toBeGreaterThan(1);
    expect(state.toon.skills.agility.xp).toBeGreaterThanOrEqual(0);
  });

  it("distanceMoved increments once per tick spent traveling, not once per trip", () => {
    const state = createInitialState();
    // Training mining requires walking to the mountain (4 base ticks from
    // the starting meadow zone, no Agility discount yet at L1).
    state.directives.push({ type: "train", target: "mining", issuedAt: 0 });
    let ticks = 0;
    while (state.toon.zone !== "mountain" && ticks < 20) {
      step(state);
      ticks++;
    }
    expect(state.toon.zone).toBe("mountain");
    expect(state.toon.distanceMoved).toBe(ticks);
  });

  it("travel never resolves in 0 or negative ticks even at very high Agility", () => {
    const state = createInitialState();
    state.toon.skills.agility.level = 999;
    // Train mining (mountain, 4 base ticks) rather than hunt -- hunt
    // routes through pickHuntZone/local-approach logic which can settle
    // in zero real cross-zone travel; this exercises the discounted
    // travelTicksBetween call site directly. At this Agility level the
    // 70%-cap discount collapses the trip to the 1-tick floor, so the
    // toon arrives within this very step -- assert on the zone actually
    // resolving, not on travel still being in-flight.
    state.directives.push({ type: "train", target: "mining", issuedAt: 0 });
    step(state);
    expect(state.toon.zone).toBe("mountain");
    expect(state.toon.travel).toBeNull();
  });

  it("Agility skill state (level, xp, distanceMoved) persists across save/load", () => {
    const storage = createMemStorage();
    const state = createInitialState();
    state.toon.skills.agility.level = 7;
    state.toon.skills.agility.xp = 42;
    state.toon.distanceMoved = 1234;

    saveState(state, storage, 999);
    const loaded = loadState(storage);

    expect(loaded).not.toBeNull();
    expect(loaded!.state.toon.skills.agility.level).toBe(7);
    expect(loaded!.state.toon.skills.agility.xp).toBe(42);
    expect(loaded!.state.toon.distanceMoved).toBe(1234);
  });
});
