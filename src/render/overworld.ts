import type { WorldState } from "../sim/state";
import { MONSTERS, monstersInZone } from "../sim/monsters";
import { ZONE_LABELS, TRAINING_ZONE } from "../sim/zones";

/**
 * Canvas-based 2D overworld renderer. Deliberately a pure view: it only
 * *reads* WorldState (position, travel, activeFight) and draws -- per
 * DESIGN.md's constraint, sim/ has zero knowledge this exists. Any future
 * renderer swap (better tiles, a real 2D lib) only touches this file.
 */

// Fixed layout for the four v0 zones -- enough to lay out as a small
// map graph now that each zone has a real role (training ground and/or
// monster spawns), not just an abstract id. Positions are canvas pixels.
const ZONE_LAYOUT: Record<string, { x: number; y: number; color: string }> = {
  meadow: { x: 70, y: 220, color: "#3f6e3a" },
  village: { x: 190, y: 130, color: "#6e5a3a" },
  forest: { x: 320, y: 200, color: "#2f5c3f" },
  cave: { x: 330, y: 320, color: "#4a4a52" },
  mountain: { x: 210, y: 40, color: "#5c5c66" },
  lake: { x: 80, y: 80, color: "#2f5b6e" },
};

const CANVAS_W = 420;
const CANVAS_H = 380;

function zonePos(zone: string): { x: number; y: number } {
  return ZONE_LAYOUT[zone] ?? ZONE_LAYOUT.meadow;
}

/** Skills trained at each zone, for the small "trains here" label. */
const ZONE_SKILLS: Record<string, string[]> = {};
for (const [skill, zone] of Object.entries(TRAINING_ZONE)) {
  (ZONE_SKILLS[zone] ??= []).push(skill);
}

/**
 * The toon's current draw position: its home zone if stationary, or
 * interpolated along the straight line between travel.from and travel.to
 * based on real travel progress -- genuine simulation state driving the
 * pixel position, not a canned animation.
 */
function toonDrawPos(state: WorldState): { x: number; y: number } {
  const travel = state.toon.travel;
  if (!travel) return zonePos(state.toon.zone);

  if (travel.from === travel.to) {
    // Local same-zone approach beat (hunt engaging a monster already in
    // this zone) -- render as a small outward bob rather than a segment
    // walk, since there's nowhere else to walk to.
    const home = zonePos(travel.to);
    const progress = 1 - travel.ticksRemaining / Math.max(1, travel.totalTicks);
    const bob = Math.sin(progress * Math.PI) * 14;
    return { x: home.x + bob, y: home.y - bob * 0.4 };
  }

  const from = zonePos(travel.from);
  const to = zonePos(travel.to);
  const progress = 1 - travel.ticksRemaining / Math.max(1, travel.totalTicks);
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
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

  // Paths between zones (fully connected graph -- no multi-hop
  // pathfinding in v0, see sim/zones.ts, so every pair is directly
  // walkable and drawn as a straight path).
  const zones = Object.entries(ZONE_LAYOUT);
  ctx.strokeStyle = "#2c2c34";
  ctx.lineWidth = 2;
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

  // Zones, with their monster spawns and training-ground markers laid
  // out around the hub so the toon visibly has somewhere to walk to.
  for (const [id, z] of zones) {
    const isCurrent = state.toon.zone === id;
    const label = ZONE_LABELS[id as keyof typeof ZONE_LABELS] ?? id;

    ctx.beginPath();
    ctx.fillStyle = z.color;
    ctx.arc(z.x, z.y, 24, 0, Math.PI * 2);
    ctx.fill();
    if (isCurrent) {
      ctx.strokeStyle = "#e6c34a";
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    ctx.fillStyle = "#e6e6ea";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label, z.x, z.y + 40);

    // Monster markers: small red dots ringing the zone, one per monster
    // defined there (monsters.ts), labeled on hover-equivalent (always-on
    // tiny text since there's no hover in this v0 canvas).
    const monsters = monstersInZone(id);
    monsters.forEach((_m, idx) => {
      const angle = (idx / Math.max(1, monsters.length)) * Math.PI * 2 - Math.PI / 2;
      const mx = z.x + Math.cos(angle) * 34;
      const my = z.y + Math.sin(angle) * 34;
      ctx.beginPath();
      ctx.fillStyle = "#d84f4f";
      ctx.arc(mx, my, 4, 0, Math.PI * 2);
      ctx.fill();
    });

    // Training-ground marker: a small anvil-ish square offset from the
    // zone if any skill trains here.
    const skills = ZONE_SKILLS[id];
    if (skills?.length) {
      ctx.fillStyle = "#4fa3d8";
      ctx.fillRect(z.x - 30, z.y - 34, 8, 8);
      ctx.font = "8px system-ui, sans-serif";
      ctx.fillStyle = "#8ec7e8";
      ctx.textAlign = "center";
      ctx.fillText(skills.join("/"), z.x, z.y - 40);
    }
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
