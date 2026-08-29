import type { WorldState, PoolName, SkillName } from "./state";

const DRAIN_PER_TICK = 4;
const REGEN_PER_TICK = 2;

// Gathering's exhaustion pool ("fatigue", see docs/exhaustion_pools_spec.md
// §1/§2). Tuned against main.ts's TICK_INTERVAL_MS = 1000ms so a sustained
// gathering session lasts ~3-5 minutes before hitting 0 from full (100):
// 100 / 0.5 = 200 ticks = 200s (~3.3min). Idle regen is deliberately slower
// than drain (fatigue should cost more than it's trivial to shrug off) but
// still recovers a full pool well within a short rest/other-activity break.
const FATIGUE_DRAIN_PER_TICK = 0.5;
const FATIGUE_REGEN_PER_TICK = 0.5;

// Crafting's exhaustion pool ("concentration", see
// docs/exhaustion_pools_spec.md §1/§2). Same 3-5min tuning target and rate
// as fatigue (100 / 0.5 = 200 ticks = 200s at TICK_INTERVAL_MS = 1000ms).
const CONCENTRATION_DRAIN_PER_TICK = 0.5;
const CONCENTRATION_REGEN_PER_TICK = 0.5;

/** Per-pool drain/regen rates. Falls back to the original flat
 * DRAIN_PER_TICK/REGEN_PER_TICK for the legacy stamina/energy/focus/
 * vitality/nerve pools (untouched by this task); fatigue/concentration get
 * their own slower, spec-tuned rate. */
const POOL_RATE: Partial<Record<PoolName, { drain: number; regen: number }>> = {
  fatigue: { drain: FATIGUE_DRAIN_PER_TICK, regen: FATIGUE_REGEN_PER_TICK },
  concentration: { drain: CONCENTRATION_DRAIN_PER_TICK, regen: CONCENTRATION_REGEN_PER_TICK },
};

function rateFor(pool: PoolName): { drain: number; regen: number } {
  return POOL_RATE[pool] ?? { drain: DRAIN_PER_TICK, regen: REGEN_PER_TICK };
}

/**
 * Which pool a given skill's training drains. Gathering skills (woodcutting,
 * mining, fishing) share the "fatigue" pool per docs/exhaustion_pools_spec.md
 * -- one shared exhaustion pool for anything that pulls raw materials from
 * the world, ending the gathering activity at 0 (no special reassignment,
 * falls through to the existing generic depleted-pool rest path). Thieving
 * also folds into fatigue per the spec's ruling (doesn't map cleanly to any
 * of the three categories, and the root request only asked for HP + two
 * dedicated pools). Crafting/production skills (cooking, smithing, alchemy)
 * share the "concentration" pool -- same depletion behavior as fatigue, no
 * bespoke termination code needed. Combat's pool routing (HP) is owned by
 * the sibling HP implementation task, not this one.
 */
export const SKILL_POOL: Record<SkillName, PoolName> = {
  combat: "stamina",
  woodcutting: "fatigue",
  mining: "fatigue",
  fishing: "fatigue",
  cooking: "concentration",
  smithing: "concentration",
  alchemy: "concentration",
  thieving: "fatigue",
};

/**
 * Drains the given pool by one tick's worth, floored at 0. Returns the new
 * current value so callers can immediately check for depletion.
 */
export function drainPool(state: WorldState, pool: PoolName): number {
  const p = state.toon.pools[pool];
  p.current = Math.max(0, p.current - rateFor(pool).drain);
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
    p.current = Math.min(p.max, p.current + rateFor(name).regen);
  }
}

export function isPoolDepleted(state: WorldState, pool: PoolName): boolean {
  return state.toon.pools[pool].current <= 0;
}
