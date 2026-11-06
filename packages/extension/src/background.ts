import type { Assignment, Platform } from "@backpack/core";
import { chromeTokenSource } from "./google/auth.js";
import { CalendarClient } from "./google/calendar.js";
import { platformInfo, prairielearnHost } from "./platforms.js";
import { fetchCanvas } from "./sources/canvas.js";
import { fetchFlextensions } from "./sources/flextensions.js";
import { fetchGradescope } from "./sources/gradescope.js";
import { fetchPrairieLearn } from "./sources/prairielearn.js";
import { refreshCourseWebsites } from "./sources/websites.js";
import { chromeStore, type State } from "./state.js";
import { syncOnce, type Source } from "./sync.js";
import { showWebsiteBadge } from "./websites.js";

const ALARM = "sync";
const SYNC_EVERY_MINUTES = 180;

export type Request = { type: "sync" } | { type: "connectGoogle" } | { type: "findWebsites" };
export type Reply = { ok: true } | { ok: false; error: string };

const READERS: Partial<Record<Platform, (state: State) => Promise<Assignment[]>>> = {
  canvas: (state) => fetchCanvas(state.canvasHost!),
  gradescope: () => fetchGradescope(),
  prairielearn: (state) => fetchPrairieLearn(prairielearnHost(state)),
  flextensions: () => fetchFlextensions(),
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

let lookingForWebsites: Promise<void> | null = null;

/**
 * Looks through bCourses for course websites (at most daily unless `force`d)
 * and updates the toolbar badge. Needs Canvas set up and allowed.
 */
function findWebsites(force: boolean): Promise<void> {
  lookingForWebsites ??= (async () => {
    try {
      const state = await chromeStore.load();
      const origins = platformInfo("canvas").origins(state);
      if (!state.platforms.includes("canvas") || !origins) return;
      if (!(await chrome.permissions.contains({ origins }))) return;
      await refreshCourseWebsites(chromeStore, state.canvasHost!, { force });
    } finally {
      lookingForWebsites = null;
      await showWebsiteBadge(await chromeStore.load());
    }
  })();
  return lookingForWebsites;
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
      // A failed calendar sync shouldn't stop Backpack from finding course websites.
      await findWebsites(false).catch(() => {});
    }
  })();
  return running;
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(ALARM, { periodInMinutes: SYNC_EVERY_MINUTES, delayInMinutes: 1 });
  void chromeStore.load().then(showWebsiteBadge);
});

// Chrome doesn't keep badges across restarts.
chrome.runtime.onStartup.addListener(() => {
  void chromeStore.load().then(showWebsiteBadge);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // Background syncs never pop up a sign-in; failures show in the menu instead.
  if (alarm.name === ALARM) sync(false).catch(() => {});
});

chrome.runtime.onMessage.addListener((request: Request, _sender, reply: (r: Reply) => void) => {
  const work =
    request.type === "connectGoogle"
      ? chrome.identity.getAuthToken({ interactive: true }).then(() => undefined)
      : request.type === "findWebsites"
        ? findWebsites(true)
        : sync(true);
  work.then(
    () => reply({ ok: true }),
    (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true; // the reply comes later
});
