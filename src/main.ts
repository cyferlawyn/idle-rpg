import "./style.css";
import { createInitialState } from "./sim/state";
import { runTicks } from "./sim/tick";
import { issueDirective } from "./sim/decision";
import { initOverworldCanvas, renderOverworld, renderFightScreen } from "./render/overworld";
import { initNodeTooltip } from "./render/tooltip";
import { XP_TO_LEVEL } from "./sim/xp";

const TICK_INTERVAL_MS = 1000;

const state = createInitialState();

// Bootstrap: start the toon training combat by default so there's visible
// progress with zero player input -- proves the "plays itself" premise.
// This directive is now correctly consumed once stamina depletes (see
// sim/tick.ts) rather than running forever -- fixed a real bug where
// generic directives never expired and silently blocked later nudges.
state.directives.push({ type: "train", target: "combat", issuedAt: 0 });
// Seed a little starting prayer so the quest directive button is usable
// immediately without waiting on the ambient loop -- v0 demo convenience,
// not a balance decision (see DESIGN.md open questions on prayer tuning).
state.prayer = 10;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="game">
    <canvas id="overworld"></canvas>
    <div id="fight-screen" class="fight-screen hidden"></div>

    <section class="hud-panel hud-stats" id="hud-stats">
      <button class="hud-toggle" data-target="hud-stats" aria-label="Collapse">▾</button>
      <h1>idle-rpg <span class="tag">devlog build</span></h1>
      <div class="hud-body">
        <div class="activity">Now: <strong id="current-activity"></strong></div>
        <div>Gold: <span id="gold"></span> · Prayer: <span id="prayer"></span></div>
        <div class="hud-actions">
          <button id="quest-btn">Nudge: do "Cat in the Tree" quest (costs prayer)</button>
          <button id="hunt-btn">Nudge: hunt nearby monsters (costs prayer)</button>
        </div>
      </div>
    </section>

    <section class="hud-panel hud-combat" id="hud-combat">
      <button class="hud-toggle" data-target="hud-combat" aria-label="Collapse">▾</button>
      <h2>Combat</h2>
      <div class="hud-body">
        <div class="combat-name"><strong id="toon-name"></strong> <span id="combat-badge" class="combat-badge"></span></div>
        <div class="hud-bar-row">
          <span class="hud-bar-label">HP</span>
          <div class="hud-bar"><div id="hp-bar-fill" class="hud-bar-fill hp"></div></div>
          <span id="toon-hp" class="hud-bar-text"></span>
        </div>
        <div id="pools" class="hud-pools"></div>
      </div>
    </section>

    <section class="hud-panel hud-skills" id="hud-skills">
      <button class="hud-toggle" data-target="hud-skills" aria-label="Collapse">▾</button>
      <h2>Skills</h2>
      <div class="hud-body">
        <div id="skills" class="hud-skills-list"></div>
      </div>
    </section>

    <section class="hud-panel hud-log" id="hud-log">
      <button class="hud-toggle" data-target="hud-log" aria-label="Collapse">▾</button>
      <h2>Log</h2>
      <div class="hud-body">
        <ul id="log-feed"></ul>
      </div>
    </section>
  </div>
`;

const overworldCanvas = document.querySelector<HTMLCanvasElement>("#overworld")!;
const overworld = initOverworldCanvas(overworldCanvas);
const fightScreenEl = document.querySelector<HTMLDivElement>("#fight-screen")!;
initNodeTooltip(overworld, document.querySelector<HTMLDivElement>(".game")!);

// Full-viewport canvas: keep the backing store matched to the CSS box on
// any resize (window resize, orientation change, devtools panel toggle,
// etc.) instead of only sizing once at load.
window.addEventListener("resize", () => {
  overworld.resize();
  render();
});

document.querySelector("#quest-btn")!.addEventListener("click", () => {
  issueDirective(state, "quest", "cat-in-tree");
  render();
});

document.querySelector("#hunt-btn")!.addEventListener("click", () => {
  issueDirective(state, "hunt", "nearest monster");
  render();
});

// Collapsible HUD panels: toggle a `.collapsed` class per panel, remembered
// across reloads via localStorage so the layout doesn't reset every visit.
const COLLAPSE_KEY = "idle-rpg:collapsed-panels";
function loadCollapsedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
const collapsed = loadCollapsedSet();

function applyCollapsedState(): void {
  document.querySelectorAll<HTMLElement>(".hud-panel").forEach((panel) => {
    panel.classList.toggle("collapsed", collapsed.has(panel.id));
  });
}

document.querySelectorAll<HTMLButtonElement>(".hud-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset.target!;
    if (collapsed.has(targetId)) collapsed.delete(targetId);
    else collapsed.add(targetId);
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
    applyCollapsedState();
  });
});
applyCollapsedState();

function render(): void {
  document.querySelector("#current-activity")!.textContent = state.currentActivity;
  document.querySelector("#toon-name")!.textContent = state.toon.name;
  document.querySelector("#toon-hp")!.textContent = `${state.toon.hp}/${state.toon.maxHp}`;
  document.querySelector("#gold")!.textContent = String(state.toon.gold);
  document.querySelector("#prayer")!.textContent = String(state.prayer);

  const hpPct = Math.max(0, Math.round((state.toon.hp / state.toon.maxHp) * 100));
  const hpFill = document.querySelector<HTMLDivElement>("#hp-bar-fill")!;
  hpFill.style.width = `${hpPct}%`;
  hpFill.classList.toggle("low", hpPct <= 25);

  const badge = document.querySelector<HTMLSpanElement>("#combat-badge")!;
  if (state.toon.activeFight) {
    badge.textContent = "IN COMBAT";
    badge.classList.add("active");
  } else {
    badge.textContent = "";
    badge.classList.remove("active");
  }

  const skillsEl = document.querySelector("#skills")!;
  skillsEl.innerHTML = Object.entries(state.toon.skills)
    .map(([name, skill]) => {
      const needed = XP_TO_LEVEL(skill.level);
      const pct = Math.min(100, Math.round((skill.xp / needed) * 100));
      return `
        <div class="skill-row">
          <div class="skill-row-label"><span>${name}</span><span>L${skill.level}</span></div>
          <div class="hud-bar"><div class="hud-bar-fill xp" style="width:${pct}%"></div></div>
        </div>`;
    })
    .join("");

  const poolsEl = document.querySelector("#pools")!;
  poolsEl.innerHTML = Object.entries(state.toon.pools)
    .map(([name, pool]) => {
      const pct = Math.max(0, Math.round((pool.current / pool.max) * 100));
      return `
        <div class="hud-bar-row">
          <span class="hud-bar-label">${name}</span>
          <div class="hud-bar"><div class="hud-bar-fill pool" style="width:${pct}%"></div></div>
        </div>`;
    })
    .join("");

  const logEl = document.querySelector("#log-feed")!;
  logEl.innerHTML = state.log
    .slice(-10)
    .reverse()
    .map((line) => `<li>${line}</li>`)
    .join("");

  renderOverworld(overworld, state);
  renderFightScreen(fightScreenEl, state);
}

render();
setInterval(() => {
  runTicks(state, 1);
  render();
}, TICK_INTERVAL_MS);
