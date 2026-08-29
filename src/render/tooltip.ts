import type { OverworldHandle, OverworldNode } from "./overworld";
import { MONSTERS } from "../sim/monsters";
import { SKILL_POOL } from "../sim/pools";
import { ZONE_LABELS } from "../sim/zones";

/**
 * Hover/tap tooltip for overworld map nodes (t_75412a55). Reuses the same
 * hit-testing (`handle.nodeAt`) the click handler already relies on, so
 * the tooltip and the click target always agree on what's under the
 * pointer -- no separate/duplicated geometry.
 *
 * Desktop: shown on pointer hover, follows the cursor, hidden on
 * pointerleave/pointermove-off-node. Touch: shown on tap (a real tap, not
 * a drag-to-pan -- reuses the same click-vs-drag distance threshold
 * pattern as onNodeClick), pinned near the tapped point, and dismissed by
 * a second tap anywhere else on the canvas or tapping the same node again.
 */
export interface NodeTooltipHandle {
  destroy(): void;
}

const HOVER_DRAG_THRESHOLD_PX = 6;

function describeNode(node: OverworldNode): { title: string; lines: string[] } {
  const zoneLabel = ZONE_LABELS[node.zone as keyof typeof ZONE_LABELS] ?? node.zone;

  if (node.kind === "monster") {
    const def = MONSTERS[node.refId];
    if (!def) return { title: node.name, lines: [`Zone: ${zoneLabel}`] };
    const xpParts = Object.entries(def.xpReward).map(([skill, xp]) => `${xp} ${skill}`);
    return {
      title: `${def.name} (combat)`,
      lines: [
        `Zone: ${zoneLabel}`,
        `HP: ${def.hp} · ATK: ${def.attack} · DEF: ${def.defense}`,
        `Reward: ${xpParts.join(", ")} XP · ${def.goldReward}g`,
      ],
    };
  }

  // Skill node.
  const pool = SKILL_POOL[node.refId as keyof typeof SKILL_POOL];
  return {
    title: `${node.name[0].toUpperCase()}${node.name.slice(1)} (skilling)`,
    lines: [`Zone: ${zoneLabel}`, `Trains: ${node.name}`, pool ? `Costs: ${pool}` : ""].filter(
      (l) => l.length > 0,
    ),
  };
}

/**
 * Wires hover (mouse) and tap (touch) tooltip behavior onto an already
 * -initialized overworld canvas. Returns a handle with destroy() to
 * unregister every listener + remove the tooltip element.
 */
export function initNodeTooltip(
  handle: OverworldHandle,
  container: HTMLElement,
): NodeTooltipHandle {
  const { canvas } = handle;

  const el = document.createElement("div");
  el.className = "node-tooltip hidden";
  container.appendChild(el);

  let pinnedNodeId: string | null = null;
  let hoverDragDistance = 0;
  let lastPointerDownPos = { x: 0, y: 0 };
  let usingTouch = false;

  function positionTooltip(px: number, py: number): void {
    const rect = container.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    // px/py are relative to the canvas; translate into container-relative
    // coordinates since the tooltip is appended to the container, not the
    // canvas (a canvas can't host DOM children).
    const left = px + (canvasRect.left - rect.left);
    const top = py + (canvasRect.top - rect.top);

    // Offset so the tooltip doesn't sit directly under the cursor/finger,
    // then clamp so it can't render off the right/bottom edge.
    const OFFSET = 16;
    el.style.left = "0px";
    el.style.top = "0px";
    el.style.visibility = "hidden";
    el.classList.remove("hidden");
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    el.style.visibility = "";

    let x = left + OFFSET;
    let y = top + OFFSET;
    if (x + tw > rect.width) x = left - tw - OFFSET;
    if (y + th > rect.height) y = top - th - OFFSET;
    x = Math.max(4, x);
    y = Math.max(4, y);

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  function showFor(node: OverworldNode, px: number, py: number): void {
    const { title, lines } = describeNode(node);
    el.innerHTML = `<div class="node-tooltip-title">${title}</div>${lines
      .map((l) => `<div class="node-tooltip-line">${l}</div>`)
      .join("")}`;
    positionTooltip(px, py);
    el.classList.remove("hidden");
  }

  function hide(): void {
    el.classList.add("hidden");
    pinnedNodeId = null;
  }

  function onPointerMove(e: PointerEvent): void {
    if (e.pointerType === "touch") return; // touch handled via tap, not hover
    usingTouch = false;
    hoverDragDistance += Math.hypot(e.movementX || 0, e.movementY || 0);
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const node = handle.nodeAt(px, py);
    if (node) {
      showFor(node, px, py);
    } else {
      hide();
    }
  }

  function onPointerLeave(): void {
    if (usingTouch) return; // don't dismiss a pinned tap tooltip on this
    hide();
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== "touch") return;
    usingTouch = true;
    lastPointerDownPos = { x: e.clientX, y: e.clientY };
    hoverDragDistance = 0;
  }

  function onPointerUp(e: PointerEvent): void {
    if (e.pointerType !== "touch") return;
    const dist = Math.hypot(
      e.clientX - lastPointerDownPos.x,
      e.clientY - lastPointerDownPos.y,
    );
    if (dist > HOVER_DRAG_THRESHOLD_PX) return; // was a pan, not a tap

    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const node = handle.nodeAt(px, py);
    if (!node) {
      hide();
      return;
    }
    if (pinnedNodeId === node.id) {
      // Second tap on the same node dismisses it.
      hide();
      return;
    }
    pinnedNodeId = node.id;
    showFor(node, px, py);
  }

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);

  return {
    destroy(): void {
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      el.remove();
    },
  };
}
