import { describe, it, expect, beforeEach, vi } from "vitest";
import { createInitialState } from "../src/sim/state";
import { saveState, loadState, clearSave, setupAutosave, SAVE_KEY, SAVE_VERSION, type StorageLike } from "../src/sim/storage";

/** Simple in-memory mock of the Web Storage API so these tests don't need
 * jsdom/localStorage -- exercises the real save/load code paths against
 * plain-object storage instead. */
function createMockStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe("save/load persistence", () => {
  let storage: StorageLike;

  beforeEach(() => {
    storage = createMockStorage();
  });

  it("returns null when nothing has been saved yet", () => {
    expect(loadState(storage)).toBeNull();
  });

  it("round-trips a full game state, including resources/progress counters", () => {
    const state = createInitialState();
    state.tick = 4200;
    state.prayer = 37;
    state.toon.gold = 150;
    state.toon.skills.mining.xp = 88;
    state.toon.skills.mining.level = 3;
    state.toon.kills["wolf"] = 5;

    saveState(state, storage, 1_700_000_000_000);
    const loaded = loadState(storage);

    expect(loaded).not.toBeNull();
    expect(loaded!.savedAt).toBe(1_700_000_000_000);
    expect(loaded!.state).toEqual(state);
  });

  it("stores the last-saved timestamp alongside the state", () => {
    const state = createInitialState();
    saveState(state, storage, 123);
    const raw = storage.getItem(SAVE_KEY)!;
    const parsed = JSON.parse(raw);
    expect(parsed.savedAt).toBe(123);
    expect(parsed.version).toBe(SAVE_VERSION);
  });

  it("returns null for corrupt JSON instead of throwing", () => {
    storage.setItem(SAVE_KEY, "{not valid json");
    expect(loadState(storage)).toBeNull();
  });

  it("returns null for a version mismatch", () => {
    storage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_VERSION + 1, savedAt: 1, state: createInitialState() }));
    expect(loadState(storage)).toBeNull();
  });

  it("clearSave removes a persisted save", () => {
    const state = createInitialState();
    saveState(state, storage);
    expect(loadState(storage)).not.toBeNull();
    clearSave(storage);
    expect(loadState(storage)).toBeNull();
  });

  it("saveState never throws even if the backend throws (quota exceeded etc)", () => {
    const throwing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    expect(() => saveState(createInitialState(), throwing)).not.toThrow();
  });
});

describe("setupAutosave", () => {
  it("saves on a periodic interval", () => {
    vi.useFakeTimers();
    const storage = createMockStorage();
    const state = createInitialState();
    state.toon.gold = 99;

    const teardown = setupAutosave(state, { intervalMs: 1000, storage, target: undefined });
    expect(loadState(storage)).toBeNull();

    vi.advanceTimersByTime(1000);
    expect(loadState(storage)?.state.toon.gold).toBe(99);

    teardown();
    vi.useRealTimers();
  });

  it("saves on beforeunload and pagehide via the provided target", () => {
    const storage = createMockStorage();
    const state = createInitialState();
    state.toon.gold = 42;

    const listeners: Record<string, () => void> = {};
    const mockTarget = {
      addEventListener: (type: string, cb: any) => {
        listeners[type] = cb;
      },
      removeEventListener: (type: string) => {
        delete listeners[type];
      },
    } as unknown as typeof window;

    const teardown = setupAutosave(state, { storage, target: mockTarget, intervalMs: 60_000 });

    listeners["beforeunload"]();
    expect(loadState(storage)?.state.toon.gold).toBe(42);

    state.toon.gold = 100;
    listeners["pagehide"]();
    expect(loadState(storage)?.state.toon.gold).toBe(100);

    teardown();
  });

  it("teardown stops further autosaves", () => {
    vi.useFakeTimers();
    const storage = createMockStorage();
    const state = createInitialState();

    const teardown = setupAutosave(state, { intervalMs: 500, storage, target: undefined });
    teardown();

    state.toon.gold = 999;
    vi.advanceTimersByTime(5000);
    expect(loadState(storage)).toBeNull();
    vi.useRealTimers();
  });
});
