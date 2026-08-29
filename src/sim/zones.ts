import type { SkillName } from "./state";

/**
 * All zone ids that exist in the world, independent of what's currently
 * in them (monsters, training grounds). Single source of truth so the
 * decision layer and the overworld renderer never drift out of sync on
 * "what zones exist."
 */
export const ZONE_IDS = ["meadow", "village", "forest", "cave"] as const;
export type ZoneId = (typeof ZONE_IDS)[number];

/** Human-readable zone names, used by both the log/activity text and the map. */
export const ZONE_LABELS: Record<ZoneId, string> = {
  meadow: "Meadow",
  village: "Village",
  forest: "Forest",
  cave: "Cave",
};

/**
 * Where training each skill physically happens. Previously training had
 * no location at all (it just ticked XP wherever the toon stood) -- now
 * the toon has to actually walk to the right zone before a train action
 * takes effect, same as hunting a specific monster requires being in its
 * zone. Combat trains at the meadow's practice yard (starting zone, no
 * travel needed by default), gathering at the forest grove, crafting at
 * the village workshop.
 */
export const TRAINING_ZONE: Record<SkillName, ZoneId> = {
  combat: "meadow",
  gathering: "forest",
  crafting: "village",
  alchemy: "cave",
};

/**
 * Travel time (in ticks) between adjacent zones, used to derive real
 * position/progress data for the overworld map -- farther zones take
 * longer to walk to, not a flat constant regardless of distance. Only
 * direct neighbor pairs are listed; pickTravelTicks below falls back to a
 * reasonable default for any pair not explicitly listed (there's no
 * multi-hop pathfinding in v0 -- see DESIGN.md open questions).
 */
const ZONE_DISTANCE: Record<string, number> = {
  "meadow|village": 2,
  "meadow|forest": 3,
  "meadow|cave": 4,
  "village|forest": 2,
  "village|cave": 3,
  "forest|cave": 2,
};

export function travelTicksBetween(from: ZoneId | string, to: ZoneId | string): number {
  if (from === to) return 0;
  const key = [from, to].sort().join("|");
  return ZONE_DISTANCE[key] ?? 3;
}
