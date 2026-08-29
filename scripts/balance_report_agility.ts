import { movementSpeedMultiplier } from "../src/sim/zones";

const XP_TO_LEVEL = (level: number): number => Math.round(83 * level * level + 100);
const AGILITY_XP_PER_TICK = 3;

let level = 1;
let xp = 0;
let ticks = 0;
const rows: { level: number; ticks: number; mult: string }[] = [];
const targets = [2, 3, 5, 10, 15, 20, 25, 30];
let ti = 0;
while (ti < targets.length && ticks < 200000) {
  ticks++;
  xp += AGILITY_XP_PER_TICK;
  const needed = XP_TO_LEVEL(level);
  if (xp >= needed) {
    xp -= needed;
    level++;
  }
  if (level === targets[ti]) {
    rows.push({ level, ticks, mult: movementSpeedMultiplier(level).toFixed(2) });
    ti++;
  }
}

console.log("Agility level | cum. travel ticks | speed multiplier");
for (const r of rows) console.log(`${r.level}\t${r.ticks}\t${r.mult}`);

console.log("");
console.log("Base trip transforms (3-tick and 4-tick base):");
for (const lvl of [1, 2, 3, 5, 10, 15, 20, 25, 30]) {
  const m = movementSpeedMultiplier(lvl);
  const t3 = Math.max(1, Math.round(3 * m));
  const t4 = Math.max(1, Math.round(4 * m));
  console.log(`L${lvl}: mult=${m.toFixed(2)} 3-tick->${t3} 4-tick->${t4}`);
}

console.log("");
console.log("Floor check at extreme level 999:", movementSpeedMultiplier(999));
console.log(
  "1-tick base trip at L999:",
  Math.max(1, Math.round(1 * movementSpeedMultiplier(999))),
);
