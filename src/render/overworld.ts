import type { WorldState } from "../sim/state";
import { HUNT_TRAVEL_TICKS } from "../sim/decision";
import { MONSTERS } from "../sim/monsters";

/**
 * Canvas-based 2D overworld renderer. Deliberately a pure view: it only
 * *reads* WorldState (position, travel, activeFight) and draws -- per
 * DESIGN.md's constraint, sim/ has zero knowledge this exists. Any future
 * renderer swap (better tiles, a real 2D lib) only touches this file.
 */

// Fixed layout for v0's two zones -- enough zones exist in monsters.ts/
// quests.ts to justify a real node graph once a third zone shows up.
// Positions are in canvas-space pixels.
const ZONE_LAYOUT: Record<string, { x: number; y: number; label: string; color: string }> = {
  meadow: { x: 90, y: 140, label: "Meadow", color: "#3f6e3a" },
  village: { x: 330, y: 90, label: "Village", color: "#6e5a3a" },
};

const CANVAS_W = 420;
const CANVAS_H = 220;

function zonePos(zone: string): { x: number; y: number } {
  return ZONE_LAYOUT[zone] ?? ZONE_LAYOUT.meadow;
}

/**
 * The toon's current draw position: its home zone, or interpolated along
 * the straight line to wherever it's traveling based on real travel
 * progress (ticksRemaining vs HUNT_TRAVEL_TICKS) -- not a canned animation,
 * genuine simulation state driving the pixel position.
 */
function toonDrawPos(state: WorldState): { x: number; y: number } {
  const home = zonePos(state.toon.zone);
  const travel = state.toon.travel;
  if (!travel) return home;

  // v0 has no explicit "which zone am I traveling toward" field (hunt
  // travel is same-zone monster approach), so render travel as a small
  // outward bob near the home zone -- honest about what state actually
  // tracks rather than inventing a destination zone that doesn't exist.
  const progress = 1 - travel.ticksRemaining / HUNT_TRAVEL_TICKS;
  const bob = Math.sin(progress * Math.PI) * 18;
  return { x: home.x + bob, y: home.y - bob * 0.4 };
}

export function initOverworldCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

export function renderOverworld(ctx: CanvasRenderingContext2D, state: WorldState): void {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // Background
  ctx.fillStyle = "#14141a";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Path between zones
  const zones = Object.entries(ZONE_LAYOUT);
  ctx.strokeStyle = "#3a3a44";
  ctx.lineWidth = 3;
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const [, a] = zones[i];
      const [, b] = zones[j];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  // Zones
  for (const [id, z] of zones) {
    const isCurrent = state.toon.zone === id;
    ctx.beginPath();
    ctx.fillStyle = z.color;
    ctx.arc(z.x, z.y, 26, 0, Math.PI * 2);
    ctx.fill();
    if (isCurrent) {
      ctx.strokeStyle = "#e6c34a";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.fillStyle = "#e6e6ea";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(z.label, z.x, z.y + 42);
  }

  // Toon marker
  const pos = toonDrawPos(state);
  const inCombat = !!state.toon.activeFight;
  ctx.beginPath();
  ctx.fillStyle = inCombat ? "#d84f4f" : "#4fa3d8";
  ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Small status caption above the toon
  ctx.fillStyle = "#e6e6ea";
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(state.toon.name, pos.x, pos.y - 14);
}

/** Whether the fight-screen overlay should currently be shown. */
export function isInFight(state: WorldState): boolean {
  return !!state.toon.activeFight;
}

export function renderFightScreen(el: HTMLElement, state: WorldState): void {
  const fight = state.toon.activeFight;
  if (!fight) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  const monster = MONSTERS[fight.monsterId];
  const monsterMaxHp = monster?.hp ?? fight.monsterHp;
  const toonPct = Math.max(0, Math.round((state.toon.hp / state.toon.maxHp) * 100));
  const monsterPct = Math.max(0, Math.round((fight.monsterHp / monsterMaxHp) * 100));

  el.innerHTML = `
    <div class="fight-row">
      <div class="fight-combatant">
        <div class="fight-name">${state.toon.name}</div>
        <div class="hp-bar"><div class="hp-fill toon" style="width:${toonPct}%"></div></div>
        <div class="hp-text">${state.toon.hp}/${state.toon.maxHp}</div>
      </div>
      <div class="fight-vs">VS</div>
      <div class="fight-combatant">
        <div class="fight-name">${monster?.name ?? fight.monsterId}</div>
        <div class="hp-bar"><div class="hp-fill monster" style="width:${monsterPct}%"></div></div>
        <div class="hp-text">${fight.monsterHp}/${monsterMaxHp}</div>
      </div>
    </div>
  `;
}
