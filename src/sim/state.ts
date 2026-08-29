export type SkillName = "combat" | "gathering" | "crafting";

export interface Skill {
  level: number;
  xp: number;
}

/**
 * Travel is modeled as real state (destination + ticks remaining) rather than
 * an instant teleport-on-arrival, per DESIGN.md's "visual overworld" future
 * scope note -- so a future map view has real movement data to animate
 * instead of the concept being invented retroactively.
 */
export interface Travel {
  destination: string;
  ticksRemaining: number;
}

export interface ActiveQuest {
  questId: string;
  stepIndex: number;
  stepProgress: number;
}

export interface ToonState {
  name: string;
  hp: number;
  maxHp: number;
  skills: Record<SkillName, Skill>;
  zone: string;
  travel: Travel | null;
  gold: number;
  inventory: string[];
  activeQuest: ActiveQuest | null;
  completedQuests: string[];
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
  /**
   * Prayer: the nudge currency. Siphoned to the player (the toon's god) from
   * completed quests -- deliberately tracked at the WorldState level, not on
   * ToonState, since it's the player's resource, not the toon's (see
   * DESIGN.md "Setting: god and paladin").
   */
  prayer: number;
  /**
   * Human-readable summary of what the toon is doing *right now* (this
   * tick), e.g. "Training combat", "Questing: Cat in the Tree". Set every
   * tick from the resolved Action so the UI never has to infer current
   * activity by reading log history.
   */
  currentActivity: string;
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
      travel: null,
      gold: 0,
      inventory: [],
      activeQuest: null,
      completedQuests: [],
    },
    directives: [],
    weights: { quest: 1, hunt: 1, train: 1 },
    prayer: 0,
    currentActivity: "Idle",
    log: [],
  };
}
