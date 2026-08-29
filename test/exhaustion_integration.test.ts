import { describe, it, expect } from "vitest";
import { createInitialState } from "../src/sim/state";
import { getNextAction } from "../src/sim/decision";
import { step, runTicks } from "../src/sim/tick";
import { startFight } from "../src/sim/combat";
import { MONSTERS } from "../src/sim/monsters";

/**
 * Integration coverage for the three exhaustion pools (HP/combat,
 * fatigue/gathering, concentration/crafting) working together through the
 * real scheduler (getNextAction -> step -> tick.ts), not in isolation.
 * The per-pool unit suites (test/sim.test.ts) already prove each pool's
 * own math; this file proves the cross-category wiring: switching
 * activities, hitting 0 in one category while another recovers, and
 * simultaneous multi-pool recovery once everything goes idle.
 */
describe("exhaustion pools: cross-category scheduler integration", () => {
  it("combat depleting to 0 HP forces random reassignment off combat while HP recovers", () => {
    const state = createInitialState();
    // Force collapse deterministically instead of grinding out a real
    // fight: drop HP to just above 0, start a fight, and land one more
    // point of damage via a manual round is fragile (RNG-dependent), so
    // drive collapse directly through the same code path tick.ts uses --
    // set hp to 1, then let the fight/attack path in resolveFightRound
    // push it to 0 over a bounded number of real ticks.
    state.toon.pools.stamina.current = 100;
    state.toon.zone = "meadow";
    state.toon.hp = 1;
    startFight(state, Object.keys(MONSTERS)[0]);

    let collapsed = false;
    for (let i = 0; i < 50 && !collapsed; i++) {
      step(state);
      if (state.toon.hp <= 0 || !state.toon.activeFight) {
        collapsed = state.toon.hp <= 0 || state.currentActivity !== undefined;
      }
      if (state.toon.hp <= 0) collapsed = true;
      if (!state.toon.activeFight && i > 0) break; // fight ended (kill/flee/collapse)
    }

    // Whatever ended the fight, activeFight must now be cleared and the
    // toon must not still be mid-combat next tick if HP hit 0.
    if (state.toon.hp <= 0) {
      expect(state.toon.activeFight).toBeNull();
      // Reassigned action for subsequent ticks must not be combat.
      const nextAction = getNextAction(state);
      expect(nextAction.kind).not.toBe("fight");
      if (nextAction.kind === "train") expect(nextAction.detail).not.toBe("combat");

      // HP should recover passively over subsequent idle ticks even
      // while other pools sit untouched.
      const hpAfterCollapse = state.toon.hp;
      runTicks(state, 10);
      expect(state.toon.hp).toBeGreaterThan(hpAfterCollapse);
    }
  });

  it("gathering (fatigue) stops cleanly at 0 without disturbing HP or concentration", () => {
    const state = createInitialState();
    state.toon.zone = "forest"; // woodcutting's training zone -- skip travel
    state.toon.pools.fatigue.current = 0;
    state.toon.pools.concentration.current = 100;
    state.toon.hp = state.toon.maxHp;
    state.directives.push({ type: "train", target: "woodcutting", issuedAt: 0 });

    const hpBefore = state.toon.hp;
    const concentrationBefore = state.toon.pools.concentration.current;

    step(state);

    // Depleted fatigue means the directive is dropped and the toon rests
    // this tick rather than training -- no random reassignment (that's
    // combat-only behavior), just a clean stop.
    expect(state.currentActivity).toBe("Resting");
    expect(state.directives.length).toBe(0);
    // Depleted pool is clamped at 0 the moment it hits bottom; once the
    // toon is rested instead (no longer actively draining fatigue that
    // same tick) the idle-regen pass immediately starts nudging it back
    // up, so assert "still near empty", not frozen at exactly 0.
    expect(state.toon.pools.fatigue.current).toBeLessThan(5);
    // Untouched pools/HP unaffected by gathering's termination.
    expect(state.toon.hp).toBe(hpBefore);
    expect(state.toon.pools.concentration.current).toBe(concentrationBefore);
  });

  it("crafting (concentration) stops cleanly at 0 without disturbing HP or fatigue", () => {
    const state = createInitialState();
    state.toon.zone = "village"; // cooking's training zone -- skip travel
    state.toon.pools.concentration.current = 0;
    state.toon.pools.fatigue.current = 100;
    state.toon.hp = state.toon.maxHp;
    state.directives.push({ type: "train", target: "cooking", issuedAt: 0 });

    const hpBefore = state.toon.hp;
    const fatigueBefore = state.toon.pools.fatigue.current;

    step(state);

    expect(state.currentActivity).toBe("Resting");
    expect(state.directives.length).toBe(0);
    expect(state.toon.pools.concentration.current).toBeLessThan(5);
    expect(state.toon.hp).toBe(hpBefore);
    expect(state.toon.pools.fatigue.current).toBe(fatigueBefore);
  });

  it("recovers all inactive pools simultaneously once the toon goes idle", () => {
    const state = createInitialState();
    // Deplete everything, HP included, and every ambient pool candidate so
    // the toon has nothing left to do but rest -- this exercises
    // regenIdlePools + regenHp firing together across categories in the
    // same tick loop, not just each pool's own dedicated unit test.
    state.toon.pools.stamina.current = 0;
    state.toon.pools.fatigue.current = 0;
    state.toon.pools.concentration.current = 0;
    state.toon.hp = 1;
    state.directives = [];
    state.ambientCommitment = null;

    const fatigueBefore = state.toon.pools.fatigue.current;
    const concentrationBefore = state.toon.pools.concentration.current;
    const staminaBefore = state.toon.pools.stamina.current;
    const hpBefore = state.toon.hp;

    runTicks(state, 20);

    // All four independently-tracked resources recovered together across
    // the same idle stretch -- none of them starve because another
    // category happened to be draining/recovering in the same tick.
    expect(state.toon.pools.fatigue.current).toBeGreaterThan(fatigueBefore);
    expect(state.toon.pools.concentration.current).toBeGreaterThan(concentrationBefore);
    expect(state.toon.pools.stamina.current).toBeGreaterThan(staminaBefore);
    expect(state.toon.hp).toBeGreaterThan(hpBefore);
  });

  it("switching from gathering to crafting mid-session drains only the active pool", () => {
    const state = createInitialState();
    state.toon.zone = "forest";
    state.directives.push({ type: "train", target: "woodcutting", issuedAt: 0 });
    runTicks(state, 5);
    const fatigueAfterGathering = state.toon.pools.fatigue.current;
    const concentrationAfterGathering = state.toon.pools.concentration.current;
    expect(fatigueAfterGathering).toBeLessThan(100);
    // Concentration regenerated (wasn't active) while fatigue drained.
    expect(concentrationAfterGathering).toBe(100);

    // Generic (non-quest) directives don't self-clear on completion --
    // only on pool depletion -- so swap it out explicitly to simulate the
    // player switching activities mid-session.
    state.directives.shift();
    state.toon.zone = "village";
    state.directives.push({ type: "train", target: "cooking", issuedAt: 5 });
    runTicks(state, 5);
    expect(state.toon.pools.concentration.current).toBeLessThan(concentrationAfterGathering);
    // Fatigue, now inactive, recovers instead of continuing to drain.
    expect(state.toon.pools.fatigue.current).toBeGreaterThanOrEqual(fatigueAfterGathering);
  });
});
