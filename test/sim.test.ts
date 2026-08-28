import { describe, it, expect } from "vitest";
import { createInitialState } from "../src/sim/state";
import { getNextAction } from "../src/sim/decision";
import { step, runTicks } from "../src/sim/tick";

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

  it("completes a queued directive and pops it off", () => {
    const state = createInitialState();
    state.directives.push({ type: "quest", target: "rat-problem", issuedAt: 0 });
    step(state);
    expect(state.directives.length).toBe(0);
  });

  it("caps the log so it does not grow unbounded", () => {
    const state = createInitialState();
    state.directives.push({ type: "train", target: "combat", issuedAt: 0 });
    runTicks(state, 500);
    expect(state.log.length).toBeLessThanOrEqual(200);
  });
});
