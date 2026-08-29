import type { SkillName } from "./state";

/**
 * All zone ids that exist in the world, independent of what's currently
 * in them (monsters, training grounds). Single source of truth so the
 * decision layer and the overworld renderer never drift out of sync on
 * "what zones exist."
 */
export const ZONE_IDS = ["meadow", "village", "forest", "cave", "mountain", "lake"] as const;
export type ZoneId = (typeof ZONE_IDS)[number];

/** Human-readable zone names, used by both the log/activity text and the map. */
export const ZONE_LABELS: Record<ZoneId, string> = {
  meadow: "Meadow",
  village: "Village",
  forest: "Forest",
  cave: "Cave",
  mountain: "Mountain",
  lake: "Lake",
};

/**
 * Where training each skill physically happens. Previously training had
 * no location at all (it just ticked XP wherever the toon stood) -- now
 * the toon has to actually walk to the right zone before a train action
 * takes effect, same as hunting a specific monster requires being in its
 * zone. Combat trains at the meadow's practice yard (starting zone, no
 * travel needed by default); woodcutting at the forest treeline; mining at
 * the mountain's exposed rock face; fishing at the lake shore; cooking and
 * smithing at the village's hearth/forge (a town naturally hosts several
 * trade skills); alchemy at the cave's still; thieving in the village's
 * market crowd (same town, different corner -- a market needs marks).
 */
export const TRAINING_ZONE: Record<SkillName, ZoneId> = {
  combat: "meadow",
  woodcutting: "forest",
  mining: "mountain",
  fishing: "lake",
  cooking: "village",
  smithing: "village",
  alchemy: "cave",
  thieving: "village",
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
  "meadow|mountain": 4,
  "meadow|lake": 3,
  "village|forest": 2,
  "village|cave": 3,
  "village|mountain": 3,
  "village|lake": 2,
  "forest|cave": 2,
  "forest|mountain": 3,
  "forest|lake": 2,
  "cave|mountain": 2,
  "cave|lake": 4,
  "mountain|lake": 3,
};

export function travelTicksBetween(from: ZoneId | string, to: ZoneId | string): number {
  if (from === to) return 0;
  const key = [from, to].sort().join("|");
  return ZONE_DISTANCE[key] ?? 3;
}
