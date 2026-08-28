export type SkillName = "combat" | "gathering" | "crafting";

export interface Skill {
  level: number;
  xp: number;
}

export interface ToonState {
  name: string;
  hp: number;
  maxHp: number;
  skills: Record<SkillName, Skill>;
  zone: string;
  gold: number;
  inventory: string[];
}

export type DirectiveType = "quest" | "hunt" | "train";

export interface Directive {
  type: DirectiveType;
  target: string; // quest id, zone id, or skill name depending on type
  issuedAt: number; // sim tick timestamp
}

export interface WorldState {
  tick: number;
  toon: ToonState;
  directives: Directive[]; // queue, front = active
  weights: Record<DirectiveType, number>; // ambient priority weighting (Tier A)
  log: string[];
}

export function createInitialState(): WorldState {
  return {
    tick: 0,
    toon: {
      name: "Toon",
      hp: 20,
      maxHp: 20,
      skills: {
        combat: { level: 1, xp: 0 },
        gathering: { level: 1, xp: 0 },
        crafting: { level: 1, xp: 0 },
      },
      zone: "meadow",
      gold: 0,
      inventory: [],
    },
    directives: [],
    weights: { quest: 1, hunt: 1, train: 1 },
    log: [],
  };
}
