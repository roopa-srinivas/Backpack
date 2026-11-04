import { defaultSettings, type Assignment, type Platform, type Settings } from "@backpack/core";

export interface SyncResult {
  at: number;
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
  tasks: number;
}

/** Everything Backpack keeps in chrome.storage.local. */
export interface State {
  settings: Settings;
  /** Platforms the student checked off in the menu as ones their classes use. */
  platforms: Platform[];
  /** The school's Canvas host, e.g. "bcourses.berkeley.edu"; null until set up. */
  canvasHost: string | null;
  /** The school's PrairieLearn host; null means the shared us.prairielearn.com. */
  prairielearnHost?: string | null;
  /** Backpack's calendars by key ("all", "course:cs169a", ...). */
  calendars: Record<string, { id: string; name: string }>;
  /** The last good read from each platform, used when a later read fails. */
  cache: Partial<Record<Platform, { fetchedAt: number; assignments: Assignment[] }>>;
  lastSync: SyncResult | null;
  /** Problems from the last sync, by platform or "google". */
  errors: Partial<Record<Platform | "google", string>>;
}

export function initialState(): State {
  return { settings: defaultSettings(), platforms: [], canvasHost: null, calendars: {}, cache: {}, lastSync: null, errors: {} };
}

export interface Store {
  load(): Promise<State>;
  save(patch: Partial<State>): Promise<void>;
}

export const chromeStore: Store = {
  async load() {
    const stored = (await chrome.storage.local.get(null)) as Partial<State>;
    const state = { ...initialState(), ...stored };
    // Settings added in later versions get their defaults.
    state.settings = { ...defaultSettings(), ...stored.settings };
    // Before the checklist, setting a Canvas address was what turned Canvas on.
    if (!stored.platforms) state.platforms = stored.canvasHost ? ["canvas"] : [];
    return state;
  },
  async save(patch) {
    await chrome.storage.local.set(patch);
  },
};

export function memoryStore(initial: Partial<State> = {}): Store & { state: State } {
  const store = {
    state: { ...initialState(), ...initial },
    async load() {
      return structuredClone(store.state);
    },
    async save(patch: Partial<State>) {
      store.state = { ...store.state, ...structuredClone(patch) };
    },
  };
  return store;
}
