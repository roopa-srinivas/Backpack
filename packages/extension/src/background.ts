import type { Assignment, Platform } from "@backpack/core";
import { chromeTokenSource } from "./google/auth.js";
import { CalendarClient } from "./google/calendar.js";
import { platformInfo, prairielearnHost } from "./platforms.js";
import { fetchCanvas } from "./sources/canvas.js";
import { fetchGradescope } from "./sources/gradescope.js";
import { fetchPrairieLearn } from "./sources/prairielearn.js";
import { chromeStore, type State } from "./state.js";
import { syncOnce, type Source } from "./sync.js";

const ALARM = "sync";
const SYNC_EVERY_MINUTES = 180;

export type Request = { type: "sync" } | { type: "connectGoogle" };
export type Reply = { ok: true } | { ok: false; error: string };

const READERS: Partial<Record<Platform, (state: State) => Promise<Assignment[]>>> = {
  canvas: (state) => fetchCanvas(state.canvasHost!),
  gradescope: () => fetchGradescope(),
  prairielearn: (state) => fetchPrairieLearn(prairielearnHost(state)),
};

/**
 * One source per platform the student checked. A platform that isn't fully
 * set up still gets a source that fails with what to fix, so it shows in the
 * menu and its existing events stay put instead of vanishing.
 */
async function sourcesFor(state: State): Promise<Source[]> {
  return Promise.all(
    state.platforms.map(async (platform): Promise<Source> => {
      const info = platformInfo(platform);
      const origins = info.origins(state);
      const read = READERS[platform];
      if (!read || !origins) {
        return { platform, fetch: () => Promise.reject(new Error(`Finish setting up ${info.label} in the Backpack menu.`)) };
      }
      if (!(await chrome.permissions.contains({ origins }))) {
        return { platform, fetch: () => Promise.reject(new Error(`Allow Backpack to read ${info.label} in the menu.`)) };
      }
      return { platform, fetch: () => read(state) };
    }),
  );
}

let running: Promise<void> | null = null;

/** Starts a sync, or joins the one already running. */
function sync(interactive: boolean): Promise<void> {
  running ??= (async () => {
    try {
      const state = await chromeStore.load();
      const calendar = new CalendarClient(chromeTokenSource(interactive));
      await syncOnce(chromeStore, await sourcesFor(state), calendar);
    } finally {
      running = null;
    }
  })();
  return running;
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(ALARM, { periodInMinutes: SYNC_EVERY_MINUTES, delayInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // Background syncs never pop up a sign-in; failures show in the menu instead.
  if (alarm.name === ALARM) sync(false).catch(() => {});
});

chrome.runtime.onMessage.addListener((request: Request, _sender, reply: (r: Reply) => void) => {
  const work =
    request.type === "connectGoogle"
      ? chrome.identity.getAuthToken({ interactive: true }).then(() => undefined)
      : sync(true);
  work.then(
    () => reply({ ok: true }),
    (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true; // the reply comes later
});
