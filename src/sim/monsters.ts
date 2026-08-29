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
// starting/weakest zone, village a step up, forest/cave harder still.
// Expanded per your steer to give the overworld map real variety (each
// zone has its own monster(s) to walk to, not one flat "nearest monster"
// wherever the toon happens to stand).
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
  "forest-wolf": {
    id: "forest-wolf",
    name: "Wolf",
    zone: "forest",
    hp: 28,
    attack: 6,
    defense: 3,
    xpReward: { combat: 18 },
    goldReward: 5,
  },
  "forest-boar": {
    id: "forest-boar",
    name: "Wild Boar",
    zone: "forest",
    hp: 40,
    attack: 8,
    defense: 5,
    xpReward: { combat: 28 },
    goldReward: 9,
  },
  "cave-spider": {
    id: "cave-spider",
    name: "Cave Spider",
    zone: "cave",
    hp: 50,
    attack: 10,
    defense: 6,
    xpReward: { combat: 40 },
    goldReward: 14,
  },
  "cave-troll": {
    id: "cave-troll",
    name: "Troll",
    zone: "cave",
    hp: 90,
    attack: 14,
    defense: 9,
    xpReward: { combat: 65 },
    goldReward: 25,
  },
};

/** Monsters available in a zone, weakest first -- used to pick "nearest". */
export function monstersInZone(zone: string): MonsterDefinition[] {
  return Object.values(MONSTERS)
    .filter((m) => m.zone === zone)
    .sort((a, b) => a.hp - b.hp);
}
