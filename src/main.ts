import "./style.css";
import { createInitialState } from "./sim/state";
import { runTicks } from "./sim/tick";
import { issueDirective } from "./sim/decision";
import { initOverworldCanvas, renderOverworld, renderFightScreen } from "./render/overworld";

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
        <div><strong id="toon-name"></strong> — HP <span id="toon-hp"></span></div>
        <div>Gold: <span id="gold"></span> · Prayer: <span id="prayer"></span></div>
        <ul id="skills"></ul>
        <ul id="pools"></ul>
        <div class="hud-actions">
          <button id="quest-btn">Nudge: do "Cat in the Tree" quest (costs prayer)</button>
          <button id="hunt-btn">Nudge: hunt nearby monsters (costs prayer)</button>
        </div>
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

  const skillsEl = document.querySelector("#skills")!;
  skillsEl.innerHTML = Object.entries(state.toon.skills)
    .map(([name, skill]) => `<li>${name}: L${skill.level} (${skill.xp} xp)</li>`)
    .join("");

  const poolsEl = document.querySelector("#pools")!;
  poolsEl.innerHTML = Object.entries(state.toon.pools)
    .map(([name, pool]) => `<li>${name}: ${pool.current}/${pool.max}</li>`)
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
