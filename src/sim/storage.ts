import type { WorldState } from "./state";

/**
 * Persistence layer for the full game state. Kept isolated from state.ts
 * itself (no circular import) and from main.ts's DOM/interval wiring so it
 * can be unit tested with a mock storage backend instead of a real
 * localStorage/browser environment.
 */

export const SAVE_KEY = "idle-rpg:save";

/** Minimal structural subset of the Web Storage API -- lets tests pass a
 * plain-object mock instead of needing jsdom/localStorage. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** On-disk envelope: the raw WorldState plus the wall-clock time it was
 * saved at (ms since epoch) -- needed by the offline fast-forward feature
 * to compute elapsed real time since the last save, which sim ticks alone
 * can't tell you. */
export interface SaveEnvelope {
  savedAt: number;
  state: WorldState;
}

/** Bump if WorldState's shape changes in a way old saves can't satisfy.
 * loadState() rejects (returns null) any envelope with a mismatched
 * version rather than risk feeding a stale/incompatible shape into the
 * live sim. */
export const SAVE_VERSION = 1;

interface VersionedEnvelope extends SaveEnvelope {
  version: number;
}

function resolveStorage(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
}

/**
 * Serialize and persist the full game state. `savedAt` defaults to
 * Date.now() but is accepted as a param so tests can pin a deterministic
 * timestamp instead of racing the clock.
 */
export function saveState(state: WorldState, storage?: StorageLike, savedAt: number = Date.now()): void {
  const target = resolveStorage(storage);
  if (!target) return;
  const envelope: VersionedEnvelope = { version: SAVE_VERSION, savedAt, state };
  try {
    target.setItem(SAVE_KEY, JSON.stringify(envelope));
  } catch {
    // Storage can throw (quota exceeded, private-browsing restrictions,
    // disabled storage) -- a failed save should never crash the game loop.
  }
}

/**
 * Load and validate the last saved envelope. Returns null on any of:
 * nothing saved yet, corrupt JSON, or a version mismatch -- callers should
 * treat null identically to "no save exists" and fall back to a fresh
 * createInitialState().
 */
export function loadState(storage?: StorageLike): SaveEnvelope | null {
  const source = resolveStorage(storage);
  if (!source) return null;
  const raw = source.getItem(SAVE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VersionedEnvelope>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.version !== SAVE_VERSION ||
      typeof parsed.savedAt !== "number" ||
      typeof parsed.state !== "object" ||
      parsed.state === null
    ) {
      return null;
    }
    return { savedAt: parsed.savedAt, state: parsed.state as WorldState };
  } catch {
    return null;
  }
}

/** Remove any persisted save -- mainly a test/debug hook (e.g. a future
 * "reset game" button), not exercised by the normal save/load flow. */
export function clearSave(storage?: StorageLike): void {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.removeItem(SAVE_KEY);
  } catch {
    // ignore, same rationale as saveState
  }
}

/**
 * Wire up autosave: a periodic interval save plus a best-effort save on
 * page unload (covers the tab closing between interval ticks). Returns a
 * teardown function that clears both hooks -- used by tests so they don't
 * leak timers/listeners across cases.
 */
export function setupAutosave(
  state: WorldState,
  options: { intervalMs?: number; storage?: StorageLike; target?: { addEventListener: typeof window.addEventListener; removeEventListener: typeof window.removeEventListener } } = {},
): () => void {
  const { intervalMs = 30_000, storage } = options;
  const target = options.target ?? (typeof window !== "undefined" ? window : undefined);

  const doSave = () => saveState(state, storage);

  const intervalId = setInterval(doSave, intervalMs);
  target?.addEventListener("beforeunload", doSave);
  // pagehide fires more reliably than beforeunload on mobile/bfcache
  // navigations -- belt-and-suspenders for the "closing the tab" case.
  target?.addEventListener("pagehide", doSave);

  return () => {
    clearInterval(intervalId);
    target?.removeEventListener("beforeunload", doSave);
    target?.removeEventListener("pagehide", doSave);
  };
}
