import { describe, it, expect } from "vitest";
import { createInitialState } from "../src/sim/state";
import { step } from "../src/sim/tick";
import { cycleCombatStyle, STYLE_LABELS } from "../src/sim/combat";

describe("combat container integration smoke", () => {
  it("runs a full fight with style + event feed in sync, no regression", () => {
    const state = createInitialState();
    cycleCombatStyle(state);
    const styleBefore = state.toon.combatStyle;
    expect(STYLE_LABELS[styleBefore]).toBeDefined();

    state.directives.push({ type: "hunt", target: "forest", issuedAt: 0 });
    let ticks = 0;
    let sawFight = false;
    let sawEvents = false;
    while (ticks < 500) {
      step(state);
      ticks++;
      if (state.toon.activeFight) {
        sawFight = true;
        if (state.toon.activeFight.events.length > 0) sawEvents = true;
        // style must remain stable/readable throughout the fight
        expect(state.toon.combatStyle).toBe(styleBefore);
      }
      if (sawFight && !state.toon.activeFight && sawEvents) break;
    }
    expect(sawFight).toBe(true);
    expect(sawEvents).toBe(true);
    // events bounded (ring buffer)
    expect(state.toon.activeFight === null || state.toon.activeFight.events.length <= 30).toBe(true);
  });
});
