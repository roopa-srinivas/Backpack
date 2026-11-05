import { defaultSettings } from "@backpack/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeStore } from "../src/state.js";

/** An in-memory chrome.storage area. */
function storageArea(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = structuredClone(initial);
  return {
    data: () => data,
    async get(keys: string[] | null) {
      if (keys === null) return structuredClone(data);
      return structuredClone(Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])));
    },
    async set(items: Record<string, unknown>) {
      data = { ...data, ...structuredClone(items) };
    },
    async remove(keys: string[]) {
      data = Object.fromEntries(Object.entries(data).filter(([k]) => !keys.includes(k)));
    },
  };
}

let local: ReturnType<typeof storageArea>;
let sync: ReturnType<typeof storageArea>;
const settings = { ...defaultSettings("America/Los_Angeles"), titleTemplate: "{title}" };

function install(localData: Record<string, unknown>, syncData: Record<string, unknown> = {}) {
  local = storageArea(localData);
  sync = storageArea(syncData);
  vi.stubGlobal("chrome", { storage: { local, sync } });
}

beforeEach(() => vi.unstubAllGlobals());

describe("chromeStore", () => {
  it("moves the setup and calendar list to sync storage once, keeping readings on this computer", async () => {
    install({
      settings,
      platforms: ["canvas"],
      canvasHost: "bcourses.berkeley.edu",
      calendars: { all: { id: "cal-laptop", name: "Backpack" } },
      cache: { canvas: { fetchedAt: 1, assignments: [] } },
    });
    const state = await chromeStore.load();

    expect(state).toMatchObject({
      settings,
      platforms: ["canvas"],
      calendars: { all: { id: "cal-laptop", name: "Backpack" } },
      calendarsMadeHere: ["cal-laptop"],
    });
    expect(Object.keys(sync.data()).sort()).toEqual(["calendars", "canvasHost", "platforms", "settings"]);
    expect(Object.keys(local.data()).sort()).toEqual(["cache", "calendarsMadeHere"]);
  });

  it("uses what another computer already shared, and marks this computer's old calendar for cleanup", async () => {
    install(
      { settings, calendars: { all: { id: "cal-desktop", name: "Backpack" } } },
      { calendars: { all: { id: "cal-laptop", name: "Backpack" } }, platforms: ["canvas", "gradescope"] },
    );
    const state = await chromeStore.load();
    expect(state.calendars).toEqual({ all: { id: "cal-laptop", name: "Backpack" } });
    expect(state.calendarsMadeHere).toEqual(["cal-desktop"]);
    expect(state.platforms).toEqual(["canvas", "gradescope"]);
    // Settings hadn't been shared yet, so this computer's are.
    expect(sync.data().settings).toEqual(settings);
  });

  it("saves the setup to sync storage and everything else locally", async () => {
    install({});
    await chromeStore.save({ platforms: ["prairielearn"], lastSync: null, errors: { canvas: "x" }, calendarsMadeHere: ["c1"] });
    expect(sync.data()).toEqual({ platforms: ["prairielearn"] });
    expect(local.data()).toEqual({ lastSync: null, errors: { canvas: "x" }, calendarsMadeHere: ["c1"] });
  });
});
