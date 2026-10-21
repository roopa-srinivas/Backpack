import { chromeTokenSource } from "./google/auth.js";
import { CalendarClient } from "./google/calendar.js";
import { fetchCanvas } from "./sources/canvas.js";
import { chromeStore, type State } from "./state.js";
import { syncOnce, type Source } from "./sync.js";

const ALARM = "sync";
const SYNC_EVERY_MINUTES = 180;

export type Request = { type: "sync" } | { type: "connectGoogle" };
export type Reply = { ok: true } | { ok: false; error: string };

async function sourcesFor(state: State): Promise<Source[]> {
  const sources: Source[] = [];
  const host = state.canvasHost;
  if (host && (await chrome.permissions.contains({ origins: [`https://${host}/*`] }))) {
    sources.push({ platform: "canvas", fetch: () => fetchCanvas(host) });
  }
  return sources;
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
