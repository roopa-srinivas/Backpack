import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarClient } from "../src/google/calendar.js";

afterEach(() => vi.unstubAllGlobals());

const tokens = { token: async () => "t", refresh: async () => "t2" };

describe("CalendarClient", () => {
  it("calls the global fetch unbound, as service workers require", async () => {
    // Like a service worker: fetch throws when `this` is anything but the global.
    vi.stubGlobal("fetch", function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response(JSON.stringify({ id: "cal1" })));
    });
    await expect(new CalendarClient(tokens).createCalendar("Backpack", "America/Los_Angeles")).resolves.toBe("cal1");
  });
});
