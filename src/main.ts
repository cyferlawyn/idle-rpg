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
    <h1>idle-rpg <span class="tag">devlog build</span></h1>
    <section class="stats">
      <div class="activity">Now: <strong id="current-activity"></strong></div>
      <div><strong id="toon-name"></strong> — HP <span id="toon-hp"></span></div>
      <div>Gold: <span id="gold"></span> · Prayer: <span id="prayer"></span></div>
      <ul id="skills"></ul>
      <ul id="pools"></ul>
    </section>
    <section class="stats overworld-section">
      <canvas id="overworld"></canvas>
      <div id="fight-screen" class="fight-screen hidden"></div>
    </section>
    <section class="stats">
      <button id="quest-btn">Nudge: do "Cat in the Tree" quest (costs prayer)</button>
      <button id="hunt-btn">Nudge: hunt nearby monsters (costs prayer)</button>
    </section>
    <section class="log">
      <h2>Log</h2>
      <ul id="log-feed"></ul>
    </section>
  </div>
`;

const overworldCanvas = document.querySelector<HTMLCanvasElement>("#overworld")!;
const overworldCtx = initOverworldCanvas(overworldCanvas);
const fightScreenEl = document.querySelector<HTMLDivElement>("#fight-screen")!;

document.querySelector("#quest-btn")!.addEventListener("click", () => {
  issueDirective(state, "quest", "cat-in-tree");
  render();
});

document.querySelector("#hunt-btn")!.addEventListener("click", () => {
  issueDirective(state, "hunt", "nearest monster");
  render();
});

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

  renderOverworld(overworldCtx, state);
  renderFightScreen(fightScreenEl, state);
}

render();
setInterval(() => {
  runTicks(state, 1);
  render();
}, TICK_INTERVAL_MS);
