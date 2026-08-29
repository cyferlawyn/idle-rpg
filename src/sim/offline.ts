import type { WorldState, SkillName } from "./state";
import { runTicks } from "./tick";
import { XP_TO_LEVEL } from "./xp";

/**
 * Offline fast-forward: given elapsed wall-clock seconds since the last
 * save, advances the world as if it had kept running in real-time.
 *
 * Design note on "closed-form vs batched ticks": the sim's decision layer
 * (ambient weighting rerolls among tied candidates) and combat resolution
 * (per-round miss/block/hit rolls, HP-threshold-triggered flee/collapse
 * branching, forced reassignment on collapse) are both randomized and
 * branch on live state every tick. A true closed-form projection would
 * have to reimplement that entire decision tree analytically and would
 * still only match the *expected value* of a real run, not the actual
 * one the acceptance test replays and diffs against -- so it would fail
 * "verified against short real-time runs for correctness" by construction.
 * Instead this batches at the *execution* level: `runTicks` is a single
 * tight loop over pure state mutation (no rendering/DOM/logging I/O per
 * tick beyond an already-capped 200-line ring buffer), so simulating the
 * full 24h cap (86,400 ticks at the game's 1 tick/sec rate) completes in
 * low milliseconds -- the actual cost this feature needs to avoid is
 * blocking real wall-clock time or re-deriving UI/render state per tick,
 * not the tick count itself. See bench in test/offline.test.ts.
 */

export const MAX_OFFLINE_SECONDS = 24 * 60 * 60;

/** Matches main.ts's TICK_INTERVAL_MS -- one sim tick per real second. */
const MS_PER_TICK = 1000;

export interface OfflineSummary {
  /** Ticks actually simulated (elapsed seconds, capped at 24h, floored to whole ticks). */
  ticksSimulated: number;
  /** The elapsed-seconds figure used after the 24h cap was applied. */
  elapsedSecondsUsed: number;
  /** Gold gained during the fast-forward window (never negative). */
  goldGained: number;
  /** XP gained per skill during the window. */
  xpGained: Partial<Record<SkillName, number>>;
  /** Levels gained per skill during the window. */
  levelsGained: Partial<Record<SkillName, number>>;
  /** Kills gained per monster id during the window. */
  killsGained: Record<string, number>;
  /** Quest ids newly completed during the window. */
  questsCompleted: string[];
  /** Prayer gained during the window. */
  prayerGained: number;
  /** Log lines produced during the window (bounded by the sim's own 200-line cap). */
  newLogEntries: string[];
}

interface Snapshot {
  gold: number;
  prayer: number;
  skillXpLevel: Partial<Record<SkillName, { xp: number; level: number }>>;
  kills: Record<string, number>;
  completedQuests: string[];
  logLength: number;
}

function snapshot(state: WorldState): Snapshot {
  const skillXpLevel: Snapshot["skillXpLevel"] = {};
  for (const [name, skill] of Object.entries(state.toon.skills) as [SkillName, { xp: number; level: number }][]) {
    skillXpLevel[name] = { xp: skill.xp, level: skill.level };
  }
  return {
    gold: state.toon.gold,
    prayer: state.prayer,
    skillXpLevel,
    kills: { ...state.toon.kills },
    completedQuests: [...state.toon.completedQuests],
    logLength: state.log.length,
  };
}

/**
 * Computes total XP earned for a skill across a level-up window, given the
 * before/after (xp-within-level, level) pairs. Since XP_TO_LEVEL is a pure
 * function of level, total XP earned = sum of every threshold crossed plus
 * the net xp-within-level delta -- this stays exact even across multiple
 * level-ups within the fast-forwarded window without needing to replay
 * ticks (the levels/xp values themselves already came out of runTicks;
 * this just reconstructs the total XP delta for reporting).
 */
function xpEarned(before: { xp: number; level: number }, after: { xp: number; level: number }, xpToLevel: (level: number) => number): number {
  if (after.level === before.level) return after.xp - before.xp;
  let total = -before.xp;
  for (let lvl = before.level; lvl < after.level; lvl++) {
    total += xpToLevel(lvl);
  }
  total += after.xp;
  return total;
}

/**
 * Advances `state` in place to reflect `elapsedSeconds` of real offline
 * time (capped at MAX_OFFLINE_SECONDS), using the same tick/production
 * logic the live game runs, and returns a summary of what was gained.
 */
export function fastForwardOffline(state: WorldState, elapsedSeconds: number): OfflineSummary {
  const cappedSeconds = Math.max(0, Math.min(elapsedSeconds, MAX_OFFLINE_SECONDS));
  const ticks = Math.floor(cappedSeconds / (MS_PER_TICK / 1000));

  const before = snapshot(state);

  if (ticks > 0) runTicks(state, ticks);

  const after = snapshot(state);

  const xpGained: OfflineSummary["xpGained"] = {};
  const levelsGained: OfflineSummary["levelsGained"] = {};
  for (const name of Object.keys(after.skillXpLevel) as SkillName[]) {
    const b = before.skillXpLevel[name]!;
    const a = after.skillXpLevel[name]!;
    const gained = xpEarned(b, a, XP_TO_LEVEL);
    if (gained > 0) xpGained[name] = gained;
    const levelDelta = a.level - b.level;
    if (levelDelta > 0) levelsGained[name] = levelDelta;
  }

  const killsGained: Record<string, number> = {};
  for (const [id, count] of Object.entries(state.toon.kills)) {
    const delta = count - (before.kills[id] ?? 0);
    if (delta > 0) killsGained[id] = delta;
  }

  const questsCompleted = after.completedQuests.filter((q) => !before.completedQuests.includes(q));

  return {
    ticksSimulated: ticks,
    elapsedSecondsUsed: cappedSeconds,
    goldGained: Math.max(0, after.gold - before.gold),
    xpGained,
    levelsGained,
    killsGained,
    questsCompleted,
    prayerGained: Math.max(0, after.prayer - before.prayer),
    newLogEntries: state.log.slice(before.logLength),
  };
}
