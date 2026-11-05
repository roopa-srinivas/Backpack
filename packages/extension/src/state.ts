import { defaultSettings, type Assignment, type Platform, type Settings } from "@backpack/core";
import type { CourseWebsite } from "./websites.js";

export interface SyncResult {
  at: number;
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
  tasks: number;
}

/**
 * Everything Backpack keeps. The setup and the calendar list are shared by
 * every computer signed in to Chrome (see SHARED_KEYS); the rest stays on
 * this computer.
 */
export interface State {
  settings: Settings;
  /** Platforms the student checked off in the menu as ones their classes use. */
  platforms: Platform[];
  /** The school's Canvas host, e.g. "bcourses.berkeley.edu"; null until set up. */
  canvasHost: string | null;
  /** The school's PrairieLearn host; null means the shared us.prairielearn.com. */
  prairielearnHost?: string | null;
  /** Backpack's calendars by key ("all", "course:cs169a", ...). */
  calendars: Record<string, { id: string; name: string; color?: string }>;
  /**
   * Calendars this computer created. If two computers each made one at the
   * same time, the one not in the shared list is this computer's to clean up.
   */
  calendarsMadeHere: string[];
  /** The last good read from each platform, used when a later read fails. */
  cache: Partial<Record<Platform, { fetchedAt: number; assignments: Assignment[] }>>;
  lastSync: SyncResult | null;
  /** Problems from the last sync, by platform or "google". */
  errors: Partial<Record<Platform | "google", string>>;
  /** Each bCourses course's website, by Canvas course id. */
  courseWebsites: Record<string, CourseWebsite>;
  /** When Backpack last looked through bCourses for course websites. */
  websitesCheckedAt: number | null;
}

export function initialState(): State {
  return {
    settings: defaultSettings(),
    platforms: [],
    canvasHost: null,
    calendars: {},
    calendarsMadeHere: [],
    cache: {},
    lastSync: null,
    errors: {},
    courseWebsites: {},
    websitesCheckedAt: null,
  };
}

export interface Store {
  load(): Promise<State>;
  save(patch: Partial<State>): Promise<void>;
}

/**
 * Kept in chrome.storage.sync, so every computer where you use Backpack
 * shares one setup and writes to the same calendars, instead of each making
 * its own copy of every event. Readings, errors and timestamps stay local.
 */
export const SHARED_KEYS = [
  "settings",
  "platforms",
  "canvasHost",
  "prairielearnHost",
  "calendars",
  "courseWebsites",
] as const satisfies readonly (keyof State)[];

const isShared = (key: string): key is (typeof SHARED_KEYS)[number] => (SHARED_KEYS as readonly string[]).includes(key);

/**
 * Before sharing, everything lived in local storage. Moves it to sync storage
 * once, unless another computer already shared its own. Calendars this
 * computer made go on its list either way, so if another computer's
 * calendars are the shared ones, the next sync removes this computer's copies.
 */
async function moveToShared(local: Partial<State>, shared: Partial<State>): Promise<void> {
  const moving = SHARED_KEYS.filter((key) => local[key] !== undefined);
  if (!moving.length) return;
  const toShare = Object.fromEntries(moving.filter((key) => shared[key] === undefined).map((key) => [key, local[key]]));
  const madeHere = [
    ...new Set([...(local.calendarsMadeHere ?? []), ...Object.values(local.calendars ?? {}).map((c) => c.id)]),
  ];
  await chrome.storage.sync.set(toShare);
  await chrome.storage.local.set({ calendarsMadeHere: madeHere });
  await chrome.storage.local.remove([...moving]);
  Object.assign(shared, toShare);
  local.calendarsMadeHere = madeHere;
  for (const key of moving) delete local[key];
}

export const chromeStore: Store = {
  async load() {
    const [local, shared] = (await Promise.all([
      chrome.storage.local.get(null),
      chrome.storage.sync.get([...SHARED_KEYS]),
    ])) as [Partial<State>, Partial<State>];
    await moveToShared(local, shared);
    const stored = { ...local, ...shared };
    const state = { ...initialState(), ...stored };
    // Settings added in later versions get their defaults.
    state.settings = { ...defaultSettings(), ...stored.settings };
    // Before the checklist, setting a Canvas address was what turned Canvas on.
    if (!stored.platforms) state.platforms = stored.canvasHost ? ["canvas"] : [];
    return state;
  },
  async save(patch) {
    const shared: Record<string, unknown> = {};
    const local: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) (isShared(key) ? shared : local)[key] = value;
    await Promise.all([
      Object.keys(shared).length ? chrome.storage.sync.set(shared) : null,
      Object.keys(local).length ? chrome.storage.local.set(local) : null,
    ]);
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
