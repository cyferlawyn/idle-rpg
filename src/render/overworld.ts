import type { WorldState } from "../sim/state";
import { MONSTERS, monstersInZone } from "../sim/monsters";
import { ZONE_LABELS, TRAINING_ZONE } from "../sim/zones";

/**
 * Canvas-based 2D overworld renderer. Deliberately a pure view: it only
 * *reads* WorldState (position, travel, activeFight) and draws -- per
 * DESIGN.md's constraint, sim/ has zero knowledge this exists. Any future
 * renderer swap (better tiles, a real 2D lib) only touches this file.
 *
 * v0.3: canvas is a full-viewport layer with a real camera (pan + zoom)
 * instead of a fixed-size box laid out in document flow. World-space
 * coordinates (ZONE_LAYOUT etc.) are unchanged; the camera just decides
 * which slice of world space maps to which pixels each frame.
 */

// Fixed layout for the v0 zones in WORLD-SPACE units (not canvas pixels --
// the camera maps these to pixels every frame based on pan/zoom).
const ZONE_LAYOUT: Record<string, { x: number; y: number; color: string }> = {
  meadow: { x: 70, y: 220, color: "#3f6e3a" },
  village: { x: 190, y: 130, color: "#6e5a3a" },
  forest: { x: 320, y: 200, color: "#2f5c3f" },
  cave: { x: 330, y: 320, color: "#4a4a52" },
  mountain: { x: 210, y: 40, color: "#5c5c66" },
  lake: { x: 80, y: 80, color: "#2f5b6e" },
};

function zonePos(zone: string): { x: number; y: number } {
  return ZONE_LAYOUT[zone] ?? ZONE_LAYOUT.meadow;
}

/** Skills trained at each zone, for the small "trains here" label. */
const ZONE_SKILLS: Record<string, string[]> = {};
for (const [skill, zone] of Object.entries(TRAINING_ZONE)) {
  (ZONE_SKILLS[zone] ??= []).push(skill);
}

/**
 * The toon's current draw position (world-space): its home zone if
 * stationary, or interpolated along the straight line between travel.from
 * and travel.to based on real travel progress -- genuine simulation state
 * driving the pixel position, not a canned animation.
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

/** World-space bounding box of everything the map ever draws, plus margin. */
function worldBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = Object.values(ZONE_LAYOUT).map((z) => z.x);
  const ys = Object.values(ZONE_LAYOUT).map((z) => z.y);
  const margin = 80;
  return {
    minX: Math.min(...xs) - margin,
    minY: Math.min(...ys) - margin,
    maxX: Math.max(...xs) + margin,
    maxY: Math.max(...ys) + margin,
  };
}

export interface Camera {
  /** World-space point currently at the center of the viewport. */
  x: number;
  y: number;
  /** Pixels-per-world-unit. */
  zoom: number;
}

const MIN_ZOOM = 0.6;
const MAX_ZOOM = 4;

export interface OverworldHandle {
  canvas: HTMLCanvasElement;
  camera: Camera;
  /** Resize the backing store to match the canvas's current CSS box. */
  resize(): void;
  /** Recenter + fit the camera so the whole map is visible (call once on init / resize). */
  fitToView(): void;
  destroy(): void;
}

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/**
 * Wires up a full-viewport canvas with mouse/touch pan + wheel/pinch zoom.
 * The canvas element itself is expected to be styled to fill its container
 * via CSS (width:100%; height:100%) -- this only manages the backing-store
 * resolution (devicePixelRatio-aware) and the camera transform, and installs
 * the pan/zoom event listeners.
 */
export function initOverworldCanvas(canvas: HTMLCanvasElement): OverworldHandle {
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  const bounds = worldBounds();
  const camera: Camera = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    zoom: 1,
  };

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function fitToView(): void {
    resize();
    const dpr = window.devicePixelRatio || 1;
    const viewW = canvas.width / dpr;
    const viewH = canvas.height / dpr;
    const worldW = bounds.maxX - bounds.minX;
    const worldH = bounds.maxY - bounds.minY;
    const fitZoom = Math.min(viewW / worldW, viewH / worldH);
    camera.zoom = clampZoom(fitZoom);
    camera.x = (bounds.minX + bounds.maxX) / 2;
    camera.y = (bounds.minY + bounds.maxY) / 2;
  }

  // --- Pan (mouse drag + single-finger touch) ---
  let dragging = false;
  let lastPx = { x: 0, y: 0 };

  function onPointerDown(e: PointerEvent): void {
    dragging = true;
    lastPx = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const dx = e.clientX - lastPx.x;
    const dy = e.clientY - lastPx.y;
    lastPx = { x: e.clientX, y: e.clientY };
    camera.x -= dx / camera.zoom;
    camera.y -= dy / camera.zoom;
  }

  function onPointerUp(e: PointerEvent): void {
    dragging = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // no-op: capture may already be released
    }
  }

  // --- Zoom (wheel; also covers most trackpad pinch which browsers
  // report as ctrlKey+wheel) ---
  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // World point currently under the cursor, so zoom stays anchored there
    // instead of always zooming toward the map center.
    const before = screenToWorld(px, py);

    const factor = Math.exp(-e.deltaY * 0.0015);
    camera.zoom = clampZoom(camera.zoom * factor);

    const after = screenToWorld(px, py);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
  }

  function screenToWorld(px: number, py: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const viewW = rect.width;
    const viewH = rect.height;
    return {
      x: camera.x + (px - viewW / 2) / camera.zoom,
      y: camera.y + (py - viewH / 2) / camera.zoom,
    };
  }

  // --- Touch pinch-to-zoom (two-finger) ---
  const activeTouches = new Map<number, { x: number; y: number }>();
  let pinchStartDist = 0;
  let pinchStartZoom = 1;

  function onTouchStart(e: TouchEvent): void {
    for (const t of Array.from(e.changedTouches)) {
      activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
    if (activeTouches.size === 2) {
      const pts = Array.from(activeTouches.values());
      pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStartZoom = camera.zoom;
    }
  }

  function onTouchMove(e: TouchEvent): void {
    if (activeTouches.size === 2) {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (activeTouches.has(t.identifier)) {
          activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
        }
      }
      const pts = Array.from(activeTouches.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchStartDist > 0) {
        camera.zoom = clampZoom(pinchStartZoom * (dist / pinchStartDist));
      }
    }
  }

  function onTouchEnd(e: TouchEvent): void {
    for (const t of Array.from(e.changedTouches)) {
      activeTouches.delete(t.identifier);
    }
    if (activeTouches.size < 2) pinchStartDist = 0;
  }

  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("touchstart", onTouchStart, { passive: true });
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("touchend", onTouchEnd, { passive: true });
  canvas.addEventListener("touchcancel", onTouchEnd, { passive: true });

  fitToView();

  return {
    canvas,
    camera,
    resize,
    fitToView,
    destroy(): void {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
    },
  };
}

export function renderOverworld(handle: OverworldHandle, state: WorldState): void {
  const { canvas, camera } = handle;
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  const viewW = canvas.width / dpr;
  const viewH = canvas.height / dpr;

  ctx.save();
  // Reset then scale for devicePixelRatio so all subsequent drawing is in
  // CSS-pixel units regardless of backing-store resolution.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewW, viewH);

  // Background
  ctx.fillStyle = "#14141a";
  ctx.fillRect(0, 0, viewW, viewH);

  // World -> screen transform: center the camera's (x,y) in the viewport,
  // scaled by zoom. Everything below draws in world-space coordinates via
  // this same ctx transform, so icon sizes are compensated separately
  // (constant screen-size icons) where legibility matters.
  ctx.translate(viewW / 2, viewH / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  // Paths between zones (fully connected graph -- no multi-hop
  // pathfinding in v0, see sim/zones.ts, so every pair is directly
  // walkable and drawn as a straight path).
  const zones = Object.entries(ZONE_LAYOUT);
  ctx.strokeStyle = "#2c2c34";
  ctx.lineWidth = 2 / camera.zoom;
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
  // Radii/fonts are divided by zoom so icons stay a legible, roughly
  // constant screen size across zoom levels instead of shrinking to
  // illegibility when zoomed out or ballooning when zoomed in.
  for (const [id, z] of zones) {
    const isCurrent = state.toon.zone === id;
    const label = ZONE_LABELS[id as keyof typeof ZONE_LABELS] ?? id;
    const r = 24 / camera.zoom;

    ctx.beginPath();
    ctx.fillStyle = z.color;
    ctx.arc(z.x, z.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (isCurrent) {
      ctx.strokeStyle = "#e6c34a";
      ctx.lineWidth = 3 / camera.zoom;
      ctx.stroke();
    }

    ctx.fillStyle = "#e6e6ea";
    ctx.font = `${11 / camera.zoom}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(label, z.x, z.y + r * (40 / 24));

    // Monster markers: small red dots ringing the zone, one per monster
    // defined there (monsters.ts), labeled on hover-equivalent (always-on
    // tiny text since there's no hover in this v0 canvas).
    const monsters = monstersInZone(id);
    monsters.forEach((_m, idx) => {
      const angle = (idx / Math.max(1, monsters.length)) * Math.PI * 2 - Math.PI / 2;
      const ring = r * (34 / 24);
      const mx = z.x + Math.cos(angle) * ring;
      const my = z.y + Math.sin(angle) * ring;
      ctx.beginPath();
      ctx.fillStyle = "#d84f4f";
      ctx.arc(mx, my, 4 / camera.zoom, 0, Math.PI * 2);
      ctx.fill();
    });

    // Training-ground marker: a small anvil-ish square offset from the
    // zone if any skill trains here.
    const skills = ZONE_SKILLS[id];
    if (skills?.length) {
      const size = 8 / camera.zoom;
      ctx.fillStyle = "#4fa3d8";
      ctx.fillRect(z.x - r * (30 / 24), z.y - r * (34 / 24), size, size);
      ctx.font = `${8 / camera.zoom}px system-ui, sans-serif`;
      ctx.fillStyle = "#8ec7e8";
      ctx.textAlign = "center";
      ctx.fillText(skills.join("/"), z.x, z.y - r * (40 / 24));
    }
  }

  // Toon marker
  const pos = toonDrawPos(state);
  const inCombat = !!state.toon.activeFight;
  ctx.beginPath();
  ctx.fillStyle = inCombat ? "#d84f4f" : "#4fa3d8";
  ctx.arc(pos.x, pos.y, 8 / camera.zoom, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 / camera.zoom;
  ctx.stroke();

  // Small status caption above the toon
  ctx.fillStyle = "#e6e6ea";
  ctx.font = `${10 / camera.zoom}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(state.toon.name, pos.x, pos.y - 14 / camera.zoom);

  ctx.restore();
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
