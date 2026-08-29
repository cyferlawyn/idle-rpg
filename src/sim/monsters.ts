import type { SkillName } from "./state";

export interface MonsterDefinition {
  id: string;
  name: string;
  zone: string;
  hp: number;
  attack: number;
  defense: number;
  xpReward: Partial<Record<SkillName, number>>;
  goldReward: number;
}

// Zone difficulty gradient per DESIGN.md's World system -- meadow is the
// starting/weakest zone, village a step up. Kept to one monster per zone
// for v0 per your steer (tiers, not a full bestiary yet).
export const MONSTERS: Record<string, MonsterDefinition> = {
  "meadow-rat": {
    id: "meadow-rat",
    name: "Meadow Rat",
    zone: "meadow",
    hp: 12,
    attack: 3,
    defense: 1,
    xpReward: { combat: 8 },
    goldReward: 2,
  },
  "village-rat": {
    id: "village-rat",
    name: "Rat",
    zone: "village",
    hp: 18,
    attack: 4,
    defense: 2,
    xpReward: { combat: 12 },
    goldReward: 3,
  },
  "village-bandit": {
    id: "village-bandit",
    name: "Bandit",
    zone: "village",
    hp: 35,
    attack: 7,
    defense: 4,
    xpReward: { combat: 25 },
    goldReward: 8,
  },
};

/** Monsters available in a zone, weakest first -- used to pick "nearest". */
export function monstersInZone(zone: string): MonsterDefinition[] {
  return Object.values(MONSTERS)
    .filter((m) => m.zone === zone)
    .sort((a, b) => a.hp - b.hp);
}
