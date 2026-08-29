import type { WorldState } from "../sim/state";
import { MONSTERS, monstersInZone } from "../sim/monsters";
import { ZONE_LABELS, TRAINING_ZONE } from "../sim/zones";

/**
 * Canvas-based 2D overworld renderer. Deliberately a pure view: it only
 * *reads* WorldState (position, travel, activeFight) and draws -- per
 * DESIGN.md's constraint, sim/ has zero knowledge this exists. Any future
 * renderer swap (better tiles, a real 2D lib) only touches this file.
 *
 * v0.4: regions are drawn as soft boundary blobs (not just a center dot),
 * every skilling/combat node gets its own icon glyph instead of a plain
 * colored dot, and nodes are now real clickable hit targets -- world-space
 * node positions + metadata are recomputed each render and exposed on the
 * handle so a future tooltip layer (see t_75412a55) can read them, and a
 * click callback fires with the node under the pointer.
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

/** Glyph shown for each trainable skill's node icon. Plain unicode symbols
 * rather than image assets -- v0 has no art pipeline (see DESIGN.md), and
 * these render fine via system-ui/emoji fallback in any modern browser. */
const SKILL_ICONS: Record<string, string> = {
  combat: "⚔",
  woodcutting: "🪓",
  mining: "⛏",
  fishing: "🎣",
  cooking: "🍲",
  smithing: "🔨",
  alchemy: "🧪",
  thieving: "🗝",
};

/** Glyph for a monster/combat node, by rough danger tier (hp) so tougher
 * spawns read visually distinct at a glance without needing a tooltip. */
function monsterIcon(hp: number): string {
  if (hp >= 80) return "💀";
  if (hp >= 40) return "👹";
  return "🐀";
}

export type NodeKind = "skill" | "monster";

/** A single clickable/hoverable map node: a skilling spot or a monster
 * spawn. World-space position + enough metadata for a future tooltip
 * (t_75412a55) to render name/type/requirements without recomputing
 * layout itself. */
export interface OverworldNode {
  id: string;
  kind: NodeKind;
  name: string;
  zone: string;
  x: number;
  y: number;
  /** World-space radius this node currently occupies (already includes
   * the 1/zoom compensation used at render time), for hit-testing. */
  radius: number;
  /** skill name for kind==="skill", monster id for kind==="monster". */
  refId: string;
}

/** The toon's current draw position (world-space): its home zone if
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
  /** Nodes from the most recent renderOverworld() call, in world-space --
   * used for click hit-testing and available to a future tooltip layer. */
  nodes: OverworldNode[];
  /** Resize the backing store to match the canvas's current CSS box. */
  resize(): void;
  /** Recenter + fit the camera so the whole map is visible (call once on init / resize). */
  fitToView(): void;
  /** Register a callback fired with the node under the pointer on a real
   * click (pointerdown+up with negligible movement -- a drag-to-pan does
   * NOT fire this). Returns an unsubscribe function. */
  onNodeClick(cb: (node: OverworldNode) => void): () => void;
  /** Hit-test a CSS-pixel point (relative to the canvas's bounding rect)
   * against the current node set. Exposed standalone so hover-based UI
   * (tooltips) can reuse the same logic outside of a click. */
  nodeAt(px: number, py: number): OverworldNode | null;
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

  let nodes: OverworldNode[] = [];
  const clickListeners = new Set<(node: OverworldNode) => void>();

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
  let dragDistance = 0;

  function onPointerDown(e: PointerEvent): void {
    dragging = true;
    lastPx = { x: e.clientX, y: e.clientY };
    dragDistance = 0;
    canvas.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const dx = e.clientX - lastPx.x;
    const dy = e.clientY - lastPx.y;
    lastPx = { x: e.clientX, y: e.clientY };
    dragDistance += Math.hypot(dx, dy);
    camera.x -= dx / camera.zoom;
    camera.y -= dy / camera.zoom;
  }

  // A "click" (as opposed to a pan/drag) is a pointer up with negligible
  // total travel since pointerdown -- this threshold is generous enough to
  // absorb hand tremor / touch jitter without mistaking an actual small
  // pan for a click.
  const CLICK_DRAG_THRESHOLD_PX = 6;

  function onPointerUp(e: PointerEvent): void {
    dragging = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // no-op: capture may already be released
    }
    if (dragDistance <= CLICK_DRAG_THRESHOLD_PX && clickListeners.size > 0) {
      const rect = canvas.getBoundingClientRect();
      const node = nodeAt(e.clientX - rect.left, e.clientY - rect.top);
      if (node) {
        for (const cb of clickListeners) cb(node);
      }
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

  function nodeAt(px: number, py: number): OverworldNode | null {
    const world = screenToWorld(px, py);
    let best: OverworldNode | null = null;
    let bestDist = Infinity;
    for (const node of nodes) {
      const d = Math.hypot(world.x - node.x, world.y - node.y);
      if (d <= node.radius && d < bestDist) {
        best = node;
        bestDist = d;
      }
    }
    return best;
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

  const handle: OverworldHandle = {
    canvas,
    camera,
    get nodes(): OverworldNode[] {
      return nodes;
    },
    set nodes(v: OverworldNode[]) {
      nodes = v;
    },
    resize,
    fitToView,
    onNodeClick(cb: (node: OverworldNode) => void): () => void {
      clickListeners.add(cb);
      return () => clickListeners.delete(cb);
    },
    nodeAt,
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
      clickListeners.clear();
    },
  };
  return handle;
}

/** Recompute every node's world-space position + hit radius for the
 * current tick. Pure function of the zone layout (positions are static;
 * only which monsters/skills exist per zone can vary), split out from
 * renderOverworld so hit-testing and drawing always agree on where nodes
 * actually are. */
function computeNodes(): OverworldNode[] {
  const nodes: OverworldNode[] = [];
  for (const [id, z] of Object.entries(ZONE_LAYOUT)) {
    const r = 24;

    const monsters = monstersInZone(id);
    monsters.forEach((m, idx) => {
      const angle = (idx / Math.max(1, monsters.length)) * Math.PI * 2 - Math.PI / 2;
      const ring = r * (34 / 24);
      nodes.push({
        id: `monster:${m.id}`,
        kind: "monster",
        name: m.name,
        zone: id,
        x: z.x + Math.cos(angle) * ring,
        y: z.y + Math.sin(angle) * ring,
        radius: 9,
        refId: m.id,
      });
    });

    const skills = ZONE_SKILLS[id] ?? [];
    skills.forEach((skill, idx) => {
      // Spread multiple skill nodes around the zone's "inner" ring so a
      // town with several trade skills (village: cooking/smithing/
      // thieving) doesn't stack them all on one point.
      const angle =
        (idx / Math.max(1, skills.length)) * Math.PI * 2 - Math.PI / 2 + Math.PI / skills.length;
      const ring = r * (30 / 24);
      nodes.push({
        id: `skill:${id}:${skill}`,
        kind: "skill",
        name: skill,
        zone: id,
        x: z.x + Math.cos(angle) * ring,
        y: z.y + Math.sin(angle) * ring,
        radius: 10,
        refId: skill,
      });
    });
  }
  return nodes;
}

export function renderOverworld(handle: OverworldHandle, state: WorldState): void {
  const { canvas, camera } = handle;
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  const viewW = canvas.width / dpr;
  const viewH = canvas.height / dpr;

  // Recompute nodes every frame (cheap -- a handful of zones/monsters) and
  // publish on the handle for hit-testing / a future tooltip layer.
  const nodes = computeNodes();
  handle.nodes = nodes;

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

  // Regions: a soft boundary blob behind each zone's nodes, so "region"
  // reads as an actual area on the map rather than just a center dot.
  // Radius/fonts are divided by zoom so icons/labels stay a legible,
  // roughly constant screen size across zoom levels instead of shrinking
  // to illegibility when zoomed out or ballooning when zoomed in.
  for (const [id, z] of zones) {
    const isCurrent = state.toon.zone === id;
    const label = ZONE_LABELS[id as keyof typeof ZONE_LABELS] ?? id;
    const r = 24 / camera.zoom;
    const boundaryR = r * (52 / 24);

    ctx.beginPath();
    ctx.fillStyle = z.color;
    ctx.globalAlpha = 0.22;
    ctx.arc(z.x, z.y, boundaryR, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = z.color;
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.setLineDash([5 / camera.zoom, 4 / camera.zoom]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Zone home marker + highlight ring if the toon is currently here.
    ctx.beginPath();
    ctx.fillStyle = z.color;
    ctx.arc(z.x, z.y, r * 0.4, 0, Math.PI * 2);
    ctx.fill();
    if (isCurrent) {
      ctx.strokeStyle = "#e6c34a";
      ctx.lineWidth = 3 / camera.zoom;
      ctx.stroke();
    }

    // Region/location name label, placed below the boundary blob.
    ctx.fillStyle = "#e6e6ea";
    ctx.font = `${13 / camera.zoom}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(label, z.x, z.y + boundaryR + 14 / camera.zoom);
  }

  // Skilling/combat node icons -- each a small clickable circle with a
  // glyph, sized so it stays legible (and a real hit target) across the
  // whole zoom range rather than shrinking below tap-friendly size.
  for (const node of nodes) {
    const iconR = Math.max(7, node.radius) / camera.zoom;
    const glyph =
      node.kind === "skill"
        ? (SKILL_ICONS[node.refId] ?? "❔")
        : monsterIcon(MONSTERS[node.refId]?.hp ?? 0);

    ctx.beginPath();
    ctx.fillStyle = node.kind === "monster" ? "#3a1f1f" : "#1f2c3a";
    ctx.arc(node.x, node.y, iconR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = node.kind === "monster" ? "#d84f4f" : "#4fa3d8";
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.stroke();

    ctx.font = `${(iconR * 1.3).toFixed(1)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glyph, node.x, node.y);
    ctx.textBaseline = "alphabetic";
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
