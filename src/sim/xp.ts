/**
 * Shared XP curve for ALL 9 progression skills (gathering, crafting, combat).
 *
 * Resolves the contradiction flagged in unified-progression-design.md
 * Section 2 / Section 6 item 1: gathering + crafting specs standardized on
 * a quadratic curve for cross-skill balance; combat's spec had drifted to
 * match the engine's old linear placeholder (`level * 100`). The quadratic
 * curve wins since 2 of 3 sub-specs already intentionally adopted it — see
 * task t_c38bcf53 for the full reconciliation.
 */
export const XP_TO_LEVEL = (level: number): number => Math.round(83 * level * level + 100);
