export type SkillName =
  | "combat"
  | "woodcutting"
  | "mining"
  | "fishing"
  | "cooking"
  | "smithing"
  | "alchemy"
  | "thieving"
  | "agility";

/** Ambient mode's current commitment, kept as an abstract intent (not a
 * concrete Action) so e.g. "hunt" can still resolve to travel-then-fight
 * as real state changes underneath it. Untyped here (decision.ts owns the
 * real `AmbientIntent` type) to avoid a circular import; decision.ts casts
 * on read since it is the only place that constructs/consumes this value. */
export type AmbientCommitment = { kind: string; [k: string]: unknown } | null;

export interface Skill {
  level: number;
  xp: number;
}

export type PoolName = "stamina" | "energy" | "focus" | "vitality" | "nerve" | "fatigue" | "concentration";

/** The three combat styles per docs/combat-styles-spec.md (t_c2d3a4fb) --
 * each trades offense/defense differently (sword_and_board: parry+block,
 * dual_wield: highest dodge, two_handed: neither, raw damage instead).
 * Kept here (not combat.ts) so it's part of the serializable ToonState. */
export type CombatStyle = "sword_and_board" | "dual_wield" | "two_handed";

/** The three exhaustion pool categories per docs/exhaustion_pools_spec.md.
 * "hp" routes to toon.hp/maxHp directly (no pools[] entry); "fatigue" and
 * "concentration" are the two generic pools[] entries. */
export type PoolCategory = "hp" | "fatigue" | "concentration";

export interface ResourcePool {
  current: number;
  max: number;
}

/**
 * Travel is modeled as real state (source + destination zone + ticks
 * remaining) rather than an instant teleport-on-arrival, per DESIGN.md's
 * "visual overworld" future scope note -- so the map view has real
 * movement data to animate (interpolating from -> to) instead of the
 * concept being invented retroactively. `to` is a zone id (see
 * sim/zones.ts) -- any activity that needs the toon somewhere specific
 * (training a skill, hunting a specific monster) routes through this
 * same generic travel rather than each having its own ad hoc movement.
 */
export interface Travel {
  from: string;
  to: string;
  ticksRemaining: number;
  totalTicks: number;
}

export interface ActiveQuest {
  questId: string;
  stepIndex: number;
  stepProgress: number;
}

/**
 * A fight resolves as a real sequence of rounds (one per tick), per
 * DESIGN.md's architectural constraint -- not one collapsed dice roll --
 * so a future fight screen has real hit/miss/kill beats to animate rather
 * than only a before/after HP delta.
 */
/**
 * One exchanged action within a fight (a hit, miss, block, or the fight's
 * terminal beat) -- kept as a bounded ring buffer on the fight itself so
 * the fight screen has real per-round data to render distinctly instead
 * of scraping the generic text log (see task t_d4d53058).
 */
export interface FightEvent {
  turn: number;
  actor: "toon" | "monster";
  kind: "hit" | "miss" | "block" | "kill" | "flee" | "collapse";
  amount?: number;
}

/** Cap on events kept per fight -- bounds memory/render cost across a
 * very long exchange without ever needing to trim mid-fight logic. */
export const MAX_FIGHT_EVENTS = 30;

export interface ActiveFight {
  monsterId: string;
  monsterHp: number;
  /** Ring buffer of exchanged actions this fight, most recent last. */
  events: FightEvent[];
  /** Round counter, used only to tag events for stable React-free keys. */
  turn: number;
}
export interface ToonState {
  name: string;
  hp: number;
  maxHp: number;
  skills: Record<SkillName, Skill>;
  /**
   * Per-activity resource pools -- stamina drains fighting, energy drains
   * gathering, focus drains crafting/training. Each pool regenerates while
   * its associated activity is NOT being performed. Depletion is the
   * stopping condition for generic (train/hunt) directives -- see
   * DESIGN.md's stickiness note: the toon commits to an activity until it's
   * actually costly to continue, rather than rerolling every tick.
   */
  pools: Record<PoolName, ResourcePool>;
  zone: string;
  travel: Travel | null;
  gold: number;
  inventory: string[];
  activeQuest: ActiveQuest | null;
  completedQuests: string[];
  activeFight: ActiveFight | null;
  /** Lifetime kills per monster id -- lets kill-type quest steps gate on
   * real combat outcomes instead of a blind tick counter. */
  kills: Record<string, number>;
  /** Lifetime ticks spent actually traveling (Travel state active), summed
   * across every trip ever taken. Feeds passive Agility XP (see
   * docs/movement_agility_spec.md §4) and is available for future
   * UI/achievements. Not itself read by the speed formula -- Agility
   * *level* is (see movementSpeedMultiplier in zones.ts). */
  distanceMoved: number;
  /** The toon's currently equipped combat style -- drives the combat
   * container's style indicator (see sim/combat.ts cycleCombatStyle). No
   * gameplay effect yet (weapon/precision integration is future scope per
   * unified_combat_spec.md §7); this is the state slice the UI reacts to. */
  combatStyle: CombatStyle;
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
  /**
   * Ambient mode's current commitment (Tier A only -- directives always
   * take priority and aren't affected by this). Ambient previously
   * re-rolled a fresh pick every single tick, which meant even ties among
   * several available quests reroll independently each tick -- observed as
   * the toon starting a different quest every tick and never finishing
   * one. Now ambient sticks to this pick until it's no longer valid (its
   * pool depletes, or a quest pick completes/becomes otherwise invalid),
   * matching the same "commit until costly to continue" stickiness the
   * pool system already gives generic directives.
   */
  ambientCommitment: AmbientCommitment;
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
        woodcutting: { level: 1, xp: 0 },
        mining: { level: 1, xp: 0 },
        fishing: { level: 1, xp: 0 },
        cooking: { level: 1, xp: 0 },
        smithing: { level: 1, xp: 0 },
        alchemy: { level: 1, xp: 0 },
        thieving: { level: 1, xp: 0 },
        agility: { level: 1, xp: 0 },
      },
      pools: {
        stamina: { current: 100, max: 100 },
        energy: { current: 100, max: 100 },
        focus: { current: 100, max: 100 },
        vitality: { current: 100, max: 100 },
        nerve: { current: 100, max: 100 },
        // Gathering's shared exhaustion pool (woodcutting/mining/fishing/
        // thieving) per docs/exhaustion_pools_spec.md -- tuned so a
        // sustained gathering session lasts ~3-5 min at the tick rate
        // below (see FATIGUE_DRAIN_PER_TICK in pools.ts).
        fatigue: { current: 100, max: 100 },
        // Crafting's shared exhaustion pool (cooking/smithing/alchemy) per
        // docs/exhaustion_pools_spec.md -- same 3-5 min tuning target as
        // fatigue (see CONCENTRATION_DRAIN_PER_TICK in pools.ts).
        concentration: { current: 100, max: 100 },
      },
      zone: "meadow",
      travel: null,
      gold: 0,
      inventory: [],
      activeQuest: null,
      completedQuests: [],
      activeFight: null,
      kills: {},
      distanceMoved: 0,
      combatStyle: "sword_and_board",
    },
    directives: [],
    ambientCommitment: null,
    prayer: 0,
    currentActivity: "Idle",
    log: [],
  };
}
