import type { WorldState, PoolName, SkillName } from "./state";

const DRAIN_PER_TICK = 4;
const REGEN_PER_TICK = 2;

/**
 * Which pool a given skill's training drains. Gathering/production skills
 * are grouped by exertion type rather than each getting a bespoke pool:
 * physical exertion (combat, woodcutting, mining) taxes stamina, outdoor
 * patience (fishing) and precise handiwork (smithing) tax energy/focus
 * respectively, cooking taxes focus (attention at the fire), alchemy taxes
 * vitality (it's literally distilling life-essence per DESIGN.md flavor),
 * and thieving taxes nerve -- a new pool for the risk/composure a sneaky
 * skill burns through, distinct from physical stamina.
 */
export const SKILL_POOL: Record<SkillName, PoolName> = {
  combat: "stamina",
  woodcutting: "stamina",
  mining: "stamina",
  fishing: "energy",
  cooking: "focus",
  smithing: "focus",
  alchemy: "vitality",
  thieving: "nerve",
};

/**
 * Drains the given pool by one tick's worth, floored at 0. Returns the new
 * current value so callers can immediately check for depletion.
 */
export function drainPool(state: WorldState, pool: PoolName): number {
  const p = state.toon.pools[pool];
  p.current = Math.max(0, p.current - DRAIN_PER_TICK);
  return p.current;
}

/**
 * Regenerates every pool that is NOT currently being drained by the active
 * action, one tick's worth each, capped at max. Called once per tick
 * regardless of what the toon is doing, so idle/other-activity pools always
 * recover.
 */
export function regenIdlePools(state: WorldState, activePool: PoolName | null): void {
  for (const name of Object.keys(state.toon.pools) as PoolName[]) {
    if (name === activePool) continue;
    const p = state.toon.pools[name];
    p.current = Math.min(p.max, p.current + REGEN_PER_TICK);
  }
}

export function isPoolDepleted(state: WorldState, pool: PoolName): boolean {
  return state.toon.pools[pool].current <= 0;
}
