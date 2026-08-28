import "./style.css";
import { createInitialState } from "./sim/state";
import { runTicks } from "./sim/tick";

const TICK_INTERVAL_MS = 1000;

const state = createInitialState();

// Bootstrap: start the toon training combat by default so there's visible
// progress with zero player input -- proves the "plays itself" premise.
state.directives.push({ type: "train", target: "combat", issuedAt: 0 });

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="game">
    <h1>idle-rpg <span class="tag">devlog build</span></h1>
    <section class="stats">
      <div><strong id="toon-name"></strong> — HP <span id="toon-hp"></span></div>
      <ul id="skills"></ul>
    </section>
    <section class="log">
      <h2>Log</h2>
      <ul id="log-feed"></ul>
    </section>
  </div>
`;

function render(): void {
  document.querySelector("#toon-name")!.textContent = state.toon.name;
  document.querySelector("#toon-hp")!.textContent = `${state.toon.hp}/${state.toon.maxHp}`;

  const skillsEl = document.querySelector("#skills")!;
  skillsEl.innerHTML = Object.entries(state.toon.skills)
    .map(([name, skill]) => `<li>${name}: L${skill.level} (${skill.xp} xp)</li>`)
    .join("");

  const logEl = document.querySelector("#log-feed")!;
  logEl.innerHTML = state.log
    .slice(-10)
    .reverse()
    .map((line) => `<li>${line}</li>`)
    .join("");
}

render();
setInterval(() => {
  runTicks(state, 1);
  render();
}, TICK_INTERVAL_MS);
