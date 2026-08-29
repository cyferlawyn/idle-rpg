import type { WorldState } from "./state";
import { MONSTERS, monstersInZone } from "./monsters";

// Flee threshold: below this fraction of max HP the toon disengages rather
// than risking death. This is the deliberate safety net until Divine
// Intervention/resurrection exists (see DESIGN.md future scope) -- v0 has
// no real death state, just a costly retreat.
const FLEE_HP_FRACTION = 0.25;
const VARIANCE = 0.25; // +/- 25% swing per hit, per your steer ("small randomness")

function rollDamage(attack: number, defense: number): number {
  const base = Math.max(1, attack - defense);
  const swing = base * VARIANCE * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(base + swing));
}

/** Picks the weakest monster available in the toon's current zone, if any. */
export function pickMonster(state: WorldState): string | null {
  const candidates = monstersInZone(state.toon.zone);
  return candidates[0]?.id ?? null;
}

export function startFight(state: WorldState, monsterId: string): boolean {
  const def = MONSTERS[monsterId];
  if (!def) return false;
  state.toon.activeFight = { monsterId, monsterHp: def.hp };
  state.log.push(`${state.toon.name} engages a ${def.name}`);
  return true;
}

/**
 * Resolves exactly one round: toon hits the monster, monster hits back
 * (if still alive), applied as real logged events per DESIGN.md's
 * "sequence of rounds, not one opaque roll" constraint -- gives a future
 * fight screen real beats (hit/hit/kill) to animate.
 *
 * Returns the concrete outcome of the round so callers (tick.ts) can tell
 * a real kill apart from a flee -- both clear activeFight, but only a kill
 * should progress a kill-type quest step.
 */
export type FightRoundResult = "ongoing" | "kill" | "flee";

export function resolveFightRound(state: WorldState): FightRoundResult {
  const fight = state.toon.activeFight;
  if (!fight) return "ongoing";
  const def = MONSTERS[fight.monsterId];
  if (!def) {
    state.toon.activeFight = null;
    return "ongoing";
  }

  const combatLevel = state.toon.skills.combat.level;
  const toonAttack = 5 + combatLevel * 2;
  const toonDefense = 2 + combatLevel;

  const dmgToMonster = rollDamage(toonAttack, def.defense);
  fight.monsterHp = Math.max(0, fight.monsterHp - dmgToMonster);
  state.log.push(`${state.toon.name} hits ${def.name} for ${dmgToMonster}`);

  if (fight.monsterHp <= 0) {
    state.log.push(`${state.toon.name} defeats ${def.name}!`);
    for (const [skillName, xp] of Object.entries(def.xpReward) as [
      keyof typeof state.toon.skills,
      number,
    ][]) {
      state.toon.skills[skillName].xp += xp;
    }
    state.toon.gold += def.goldReward;
    state.toon.kills[def.id] = (state.toon.kills[def.id] ?? 0) + 1;
    state.toon.activeFight = null;
    return "kill";
  }

  const dmgToToon = rollDamage(def.attack, toonDefense);
  // Floor at 1, not 0 -- no permadeath in v0 (see DESIGN.md: resurrection/
  // Divine Intervention doesn't exist yet, so the toon must always survive
  // to flee rather than land on exactly 0 HP from an unlucky big hit).
  state.toon.hp = Math.max(1, state.toon.hp - dmgToToon);
  state.log.push(`${def.name} hits ${state.toon.name} for ${dmgToToon}`);

  if (state.toon.hp / state.toon.maxHp <= FLEE_HP_FRACTION) {
    state.log.push(`${state.toon.name} is badly hurt and flees the fight!`);
    state.toon.activeFight = null;
    return "flee";
  }
  return "ongoing";
}
