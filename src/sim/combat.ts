import type { WorldState, FightEvent, CombatStyle } from "./state";
import { MAX_FIGHT_EVENTS } from "./state";

/** Cycle order for the manual style-swap control (task t_8a9b15a3) -- no
 * particular ranking, just a stable rotation so repeated clicks visit all
 * three styles from any starting point. */
const STYLE_CYCLE: CombatStyle[] = ["sword_and_board", "dual_wield", "two_handed"];

/** Swaps the toon to the next combat style in STYLE_CYCLE. Purely a state
 * mutation -- no gameplay effect yet (see state.ts CombatStyle doc comment
 * on why: weapon/precision integration is future scope per
 * unified_combat_spec.md §7). Safe to call mid-fight; the indicator just
 * reflects whatever the state says on the next render. */
export function cycleCombatStyle(state: WorldState): void {
  const idx = STYLE_CYCLE.indexOf(state.toon.combatStyle);
  state.toon.combatStyle = STYLE_CYCLE[(idx + 1) % STYLE_CYCLE.length];
  state.log.push(`${state.toon.name} switches to ${STYLE_LABELS[state.toon.combatStyle]} stance`);
}

/** Human-readable labels for the UI -- kept here alongside the style enum's
 * owning module logic rather than in render/ so both the HUD badge and any
 * future combat-log text stay in sync with one source of truth. */
export const STYLE_LABELS: Record<CombatStyle, string> = {
  sword_and_board: "Sword & Board",
  dual_wield: "Dual Wield",
  two_handed: "Two-Handed",
};
import { MONSTERS, monstersInZone } from "./monsters";
import { ZONE_IDS, travelTicksBetween } from "./zones";

// Flee threshold: below this fraction of max HP the toon disengages rather
// than risking death. This is the deliberate safety net until Divine
// Intervention/resurrection exists (see DESIGN.md future scope) -- v0 has
// no real death state, just a costly retreat.
const FLEE_HP_FRACTION = 0.25;
// Recovery threshold: after fleeing, the toon won't re-engage combat until
// back above this fraction of max HP. Without this, a toon at exactly the
// flee threshold immediately re-hunts the same zone next tick, re-engages
// the same monster at the same critically low HP, and flees again --
// stuck in an endless fight/flee/retry loop with zero net progress.
const RECOVERED_HP_FRACTION = 0.6;
const VARIANCE = 0.25; // +/- 25% swing per hit, per your steer ("small randomness")
const HP_REGEN_PER_TICK = 1;
// Exchange variety for the fight screen (task t_d4d53058): each swing
// either misses outright, gets partially blocked, or connects clean.
const MISS_CHANCE = 0.15;
const BLOCK_CHANCE = 0.2;
const BLOCK_REDUCTION = 0.5; // blocked hits deal half damage

/** Whether the toon is at/above the recovery threshold and safe to hunt. */
export function isRecovered(state: WorldState): boolean {
  return state.toon.hp / state.toon.maxHp >= RECOVERED_HP_FRACTION;
}

/**
 * Passively regenerates HP by a small fixed amount, capped at max --
 * called once per tick whenever the toon isn't actively fighting (fight
 * rounds have their own HP deltas from taking damage). This is what lets
 * a fled toon actually recover instead of sitting at low HP forever with
 * nothing but time-since-flee gating the next hunt attempt.
 */
export function regenHp(state: WorldState): void {
  if (state.toon.activeFight) return;
  state.toon.hp = Math.min(state.toon.maxHp, state.toon.hp + HP_REGEN_PER_TICK);
}

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

/**
 * Picks a hunt target zone: the toon's current zone if it has any
 * monster, otherwise the nearest zone (by travel ticks) that does. This
 * is what lets "hunt nearby monsters" actually walk the toon somewhere
 * new on the map instead of only ever fighting whatever happens to share
 * its current zone.
 */
export function pickHuntZone(state: WorldState): string | null {
  if (monstersInZone(state.toon.zone).length > 0) return state.toon.zone;

  const candidates = ZONE_IDS.filter((z) => monstersInZone(z).length > 0);
  if (candidates.length === 0) return null;

  candidates.sort(
    (a, b) => travelTicksBetween(state.toon.zone, a) - travelTicksBetween(state.toon.zone, b),
  );
  return candidates[0];
}

export function startFight(state: WorldState, monsterId: string): boolean {
  const def = MONSTERS[monsterId];
  if (!def) return false;
  state.toon.activeFight = { monsterId, monsterHp: def.hp, events: [], turn: 0 };
  state.log.push(`${state.toon.name} engages a ${def.name}`);
  return true;
}

/** Appends an exchange event to the fight's bounded ring buffer, dropping
 * the oldest entries past MAX_FIGHT_EVENTS so a long exchange never grows
 * the array (and thus render cost) unboundedly. */
function pushEvent(events: FightEvent[], event: FightEvent): void {
  events.push(event);
  if (events.length > MAX_FIGHT_EVENTS) {
    events.splice(0, events.length - MAX_FIGHT_EVENTS);
  }
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
export type FightRoundResult = "ongoing" | "kill" | "flee" | "collapse";

/** Whether the toon has been beaten to 0 HP -- a hard stop distinct from
 * the voluntary flee-at-25% safety valve above 0 HP. */
export function isCollapsed(state: WorldState): boolean {
  return state.toon.hp <= 0;
}

export function resolveFightRound(state: WorldState): FightRoundResult {
  const fight = state.toon.activeFight;
  if (!fight) return "ongoing";
  const def = MONSTERS[fight.monsterId];
  if (!def) {
    state.toon.activeFight = null;
    return "ongoing";
  }

  fight.turn += 1;
  const combatLevel = state.toon.skills.combat.level;
  const toonAttack = 5 + combatLevel * 2;
  const toonDefense = 2 + combatLevel;

  // Toon's swing: MISS_CHANCE to whiff entirely, else BLOCK_CHANCE for the
  // monster to shave the hit down instead of eating it clean -- gives the
  // fight screen real hit/miss/block variety to render (task t_d4d53058)
  // instead of every exchange being an unconditional connect.
  const toonRoll = Math.random();
  if (toonRoll < MISS_CHANCE) {
    state.log.push(`${state.toon.name} swings at ${def.name} and misses`);
    pushEvent(fight.events, { turn: fight.turn, actor: "toon", kind: "miss" });
  } else {
    const blocked = toonRoll < MISS_CHANCE + BLOCK_CHANCE;
    const rawDmg = rollDamage(toonAttack, def.defense);
    const dmgToMonster = blocked ? Math.max(0, Math.round(rawDmg * (1 - BLOCK_REDUCTION))) : rawDmg;
    fight.monsterHp = Math.max(0, fight.monsterHp - dmgToMonster);
    if (blocked) {
      state.log.push(`${def.name} blocks ${state.toon.name}'s attack, taking ${dmgToMonster}`);
      pushEvent(fight.events, { turn: fight.turn, actor: "toon", kind: "block", amount: dmgToMonster });
    } else {
      state.log.push(`${state.toon.name} hits ${def.name} for ${dmgToMonster}`);
      pushEvent(fight.events, { turn: fight.turn, actor: "toon", kind: "hit", amount: dmgToMonster });
    }
  }

  if (fight.monsterHp <= 0) {
    state.log.push(`${state.toon.name} defeats ${def.name}!`);
    pushEvent(fight.events, { turn: fight.turn, actor: "toon", kind: "kill" });
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

  // Monster's swing: same miss/block/hit roll, mirrored for the other side.
  const monsterRoll = Math.random();
  let dmgToToon = 0;
  if (monsterRoll < MISS_CHANCE) {
    state.log.push(`${def.name} attacks ${state.toon.name} and misses`);
    pushEvent(fight.events, { turn: fight.turn, actor: "monster", kind: "miss" });
  } else {
    const blocked = monsterRoll < MISS_CHANCE + BLOCK_CHANCE;
    const rawDmg = rollDamage(def.attack, toonDefense);
    dmgToToon = blocked ? Math.max(0, Math.round(rawDmg * (1 - BLOCK_REDUCTION))) : rawDmg;
    if (blocked) {
      state.log.push(`${state.toon.name} blocks ${def.name}'s attack, taking ${dmgToToon}`);
      pushEvent(fight.events, { turn: fight.turn, actor: "monster", kind: "block", amount: dmgToToon });
    } else {
      state.log.push(`${def.name} hits ${state.toon.name} for ${dmgToToon}`);
      pushEvent(fight.events, { turn: fight.turn, actor: "monster", kind: "hit", amount: dmgToToon });
    }
  }

  // Floor at 0 now -- HP hitting exactly 0 is the new "collapse" hard stop
  // (see docs/exhaustion_pools_spec.md §4). No permadeath still holds: 0 HP
  // isn't death, just an involuntary end to the fight with forced
  // reassignment, distinct from the voluntary flee-at-25% safety valve.
  state.toon.hp = Math.max(0, state.toon.hp - dmgToToon);

  if (state.toon.hp <= 0) {
    state.log.push(`${state.toon.name} collapses from exhaustion!`);
    pushEvent(fight.events, { turn: fight.turn, actor: "monster", kind: "collapse" });
    state.toon.activeFight = null;
    return "collapse";
  }

  if (state.toon.hp / state.toon.maxHp <= FLEE_HP_FRACTION) {
    state.log.push(`${state.toon.name} is badly hurt and flees the fight!`);
    pushEvent(fight.events, { turn: fight.turn, actor: "toon", kind: "flee" });
    state.toon.activeFight = null;
    return "flee";
  }
  return "ongoing";
}
