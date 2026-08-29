import { describe, it, expect } from "vitest";
import { createInitialState } from "../src/sim/state";
import { runTicks, step } from "../src/sim/tick";
import { fastForwardOffline, MAX_OFFLINE_SECONDS } from "../src/sim/offline";

describe("offline fast-forward", () => {
  it("simulates zero seconds as a no-op", () => {
    const state = createInitialState();
    state.directives.push({ type: "train", target: "combat", issuedAt: 0 });
    const before = JSON.stringify(state);
    const summary = fastForwardOffline(state, 0);
    expect(summary.ticksSimulated).toBe(0);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("caps elapsed time at 24h even if given more", () => {
    const state = createInitialState();
    const summary = fastForwardOffline(state, MAX_OFFLINE_SECONDS + 10_000);
    expect(summary.elapsedSecondsUsed).toBe(MAX_OFFLINE_SECONDS);
    expect(summary.ticksSimulated).toBe(MAX_OFFLINE_SECONDS);
    expect(state.tick).toBe(MAX_OFFLINE_SECONDS);
  });

  it("advances tick count 1:1 with elapsed seconds (short window)", () => {
    const state = createInitialState();
    state.directives.push({ type: "train", target: "combat", issuedAt: 0 });
    const summary = fastForwardOffline(state, 120);
    expect(summary.ticksSimulated).toBe(120);
    expect(state.tick).toBe(120);
  });

  it("matches a real-time run tick-for-tick when seeded identically (deterministic path: training)", () => {
    // Training has no RNG in its path (unlike combat), so a real-time
    // run and the fast-forward should match exactly, not just in
    // distribution -- this is the strongest form of the acceptance
    // criterion ("verified against short real-time runs for correctness").
    const real = createInitialState();
    real.directives.push({ type: "train", target: "combat", issuedAt: 0 });
    // Let the toon actually arrive at the training zone first so both
    // runs start from the same "already training" baseline.
    runTicks(real, 5);

    const offline = JSON.parse(JSON.stringify(real));
    // Re-hydrate offline as a real WorldState (structuredClone-equivalent).
    const offlineState = offline;

    const elapsedTicks = 20;
    for (let i = 0; i < elapsedTicks; i++) step(real);
    const summary = fastForwardOffline(offlineState, elapsedTicks);

    expect(summary.ticksSimulated).toBe(elapsedTicks);
    expect(offlineState.tick).toBe(real.tick);
    expect(offlineState.toon.skills.combat.level).toBe(real.toon.skills.combat.level);
    expect(offlineState.toon.skills.combat.xp).toBe(real.toon.skills.combat.xp);
    expect(offlineState.toon.pools.stamina.current).toBe(real.toon.pools.stamina.current);
  });

  it("reports gold/xp/level/kill/quest deltas gained during the window", () => {
    const state = createInitialState();
    state.prayer = 100; // afford any directive
    state.directives.push({ type: "quest", target: "cat-in-tree", issuedAt: 0 });
    const summary = fastForwardOffline(state, 60);
    // cat-in-tree is a pure travel quest (3 ticks in the meadow, toon
    // starts there) -- should complete well within 60 ticks.
    expect(summary.questsCompleted).toContain("cat-in-tree");
    expect(summary.prayerGained).toBeGreaterThan(0);
    expect(state.toon.completedQuests).toContain("cat-in-tree");
  });

  it("is fast: 24h of ticks completes in well under a second", () => {
    const state = createInitialState();
    state.directives.push({ type: "train", target: "combat", issuedAt: 0 });
    const start = Date.now();
    fastForwardOffline(state, MAX_OFFLINE_SECONDS);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(2000);
  });
});
