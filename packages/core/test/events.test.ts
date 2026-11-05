import { describe, expect, it } from "vitest";
import { buildEvents, defaultSettings, mergeAssignments, planSync, renderTitle, type Settings } from "../src/index.js";
import { assignment } from "./helpers.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const settings = (overrides: Partial<Settings> = {}): Settings => ({
  ...defaultSettings("America/Los_Angeles"),
  ...overrides,
});

describe("buildEvents", () => {
  it("makes a 30-minute event ending at the due time by default", () => {
    const [event] = buildEvents(mergeAssignments([assignment("gradescope")]), settings(), NOW);
    expect(event!.calendarKey).toBe("all");
    expect(event!.calendarName).toBe("Backpack");
    expect(event!.body.summary).toBe("CS 169A · Homework 3: Ruby Intro");
    expect(event!.body.start).toEqual({ dateTime: "2026-10-24T06:29:00.000Z", timeZone: "America/Los_Angeles" });
    expect(event!.body.end).toEqual({ dateTime: "2026-10-24T06:59:00.000Z", timeZone: "America/Los_Angeles" });
    expect(event!.body.description).toContain("Due Fri, Oct 23, 11:59 PM");
    expect(event!.body.reminders.overrides).toEqual([
      { method: "popup", minutes: 1440 },
      { method: "popup", minutes: 120 },
    ]);
  });

  it("puts all-day events on the local due date", () => {
    const [event] = buildEvents(mergeAssignments([assignment("canvas")]), settings({ style: { type: "allDay" } }), NOW);
    expect(event!.body.start).toEqual({ date: "2026-10-23" });
    expect(event!.body.end).toEqual({ date: "2026-10-24" });
  });

  it("files a midnight deadline under the day before", () => {
    const midnight = assignment("canvas", { dueAt: "2026-10-24T07:00:00Z" }); // 12:00 AM Saturday in Berkeley
    const [event] = buildEvents(mergeAssignments([midnight]), settings({ style: { type: "allDay" } }), NOW);
    expect(event!.body.start).toEqual({ date: "2026-10-23" });
  });

  it("schedules a work block ending some hours before the deadline", () => {
    const style = { type: "workBlock", minutes: 120, hoursBefore: 24 } as const;
    const [event] = buildEvents(mergeAssignments([assignment("canvas")]), settings({ style }), NOW);
    expect(event!.body.start).toMatchObject({ dateTime: "2026-10-23T04:59:00.000Z" });
    expect(event!.body.end).toMatchObject({ dateTime: "2026-10-23T06:59:00.000Z" });
  });

  it("splits calendars per course or per platform", () => {
    const tasks = mergeAssignments([assignment("canvas")]);
    expect(buildEvents(tasks, settings({ calendars: "perCourse" }), NOW)[0]).toMatchObject({
      calendarKey: "course:cs169a",
      calendarName: "Backpack · CS 169A",
    });
    expect(buildEvents(tasks, settings({ calendars: "perPlatform" }), NOW)[0]).toMatchObject({
      calendarKey: "platform:canvas",
      calendarName: "Backpack · Canvas",
    });
  });

  it("applies course labels, colors and hiding", () => {
    const tasks = mergeAssignments([assignment("canvas")]);
    const labeled = buildEvents(tasks, settings({ courses: { cs169a: { label: "SWE", color: "7" } } }), NOW)[0]!;
    expect(labeled.body.summary).toBe("SWE · Homework 3: Ruby Intro");
    expect(labeled.body.colorId).toBe("7");
    expect(buildEvents(tasks, settings({ courses: { cs169a: { hidden: true } } }), NOW)).toEqual([]);
  });

  it("checks off, hides or keeps submitted work", () => {
    const tasks = mergeAssignments([assignment("canvas", { submitted: true })]);
    expect(buildEvents(tasks, settings({ submitted: "check" }), NOW)[0]!.body.summary).toMatch(/^✓ /);
    expect(buildEvents(tasks, settings({ submitted: "hide" }), NOW)).toEqual([]);
    expect(buildEvents(tasks, settings({ submitted: "keep" }), NOW)[0]!.body.summary).not.toMatch(/✓/);
  });

  it("skips undated work and work long past", () => {
    const tasks = mergeAssignments([
      assignment("canvas", { dueAt: null }),
      assignment("canvas", { title: "Old", dueAt: "2026-10-01T07:00:00Z" }),
    ]);
    expect(buildEvents(tasks, settings(), NOW)).toEqual([]);
  });

  it("lists every platform link in the description", () => {
    const tasks = mergeAssignments([assignment("canvas"), assignment("gradescope")]);
    const { description, source } = buildEvents(tasks, settings(), NOW)[0]!.body;
    expect(description).toMatch(/Gradescope: https:\/\/gradescope\.example\/\d+\nCanvas: https:\/\/canvas\.example\/\d+/);
    expect(source.title).toBe("Gradescope");
  });

  it("gives identical tasks identical fingerprints, and changed ones new ones", () => {
    const a = buildEvents(mergeAssignments([assignment("canvas", { id: "x", url: "https://canvas.example/x" })]), settings(), NOW)[0]!;
    const b = buildEvents(mergeAssignments([assignment("canvas", { id: "x", url: "https://canvas.example/x" })]), settings(), NOW)[0]!;
    const moved = buildEvents(
      mergeAssignments([assignment("canvas", { id: "x", url: "https://canvas.example/x", dueAt: "2026-10-25T06:59:00Z" })]),
      settings(),
      NOW,
    )[0]!;
    expect(a.hash).toBe(b.hash);
    expect(moved.hash).not.toBe(a.hash);
  });
});

describe("renderTitle", () => {
  it("fills placeholders and tidies an empty {points}", () => {
    const [task] = mergeAssignments([assignment("prairielearn", { kind: "quiz" })]);
    expect(renderTitle("[{platform}] {title} ({kind})", task!, "CS 169A")).toBe("[PrairieLearn] Homework 3: Ruby Intro (quiz)");
    expect(renderTitle("{title} · {points}", task!, "CS 169A")).toBe("Homework 3: Ruby Intro");
    expect(renderTitle("{title} {nope}", task!, "CS 169A")).toBe("Homework 3: Ruby Intro {nope}");
  });
});

describe("planSync", () => {
  const desired = buildEvents(
    mergeAssignments([assignment("canvas", { id: "a" }), assignment("canvas", { id: "b", title: "Lab 2" })]),
    settings(),
    NOW,
  );
  const [a, b] = desired as [(typeof desired)[0], (typeof desired)[0]];

  it("creates new events, updates changed ones and leaves the rest", () => {
    const plan = planSync(desired, [{ calendarKey: "all", eventId: "e1", taskKey: a.taskKey, hash: "stale" }]);
    expect(plan.create).toEqual([b]);
    expect(plan.update).toEqual([{ eventId: "e1", event: a }]);
    expect(plan.remove).toEqual([]);

    const settled = planSync(desired, [
      { calendarKey: "all", eventId: "e1", taskKey: a.taskKey, hash: a.hash },
      { calendarKey: "all", eventId: "e2", taskKey: b.taskKey, hash: b.hash },
    ]);
    expect(settled).toMatchObject({ create: [], update: [], remove: [], unchanged: 2 });
  });

  it("removes events for tasks that are gone, duplicates, and copies in the wrong calendar", () => {
    const gone = { calendarKey: "all", eventId: "e9", taskKey: "canvas:gone", hash: "h" };
    const dupe = { calendarKey: "all", eventId: "e3", taskKey: a.taskKey, hash: a.hash };
    const moved = { calendarKey: "course:cs169a", eventId: "e4", taskKey: b.taskKey, hash: b.hash };
    const plan = planSync(desired, [{ ...dupe, eventId: "e1" }, dupe, moved, gone], ["all", "course:cs169a"]);
    expect(plan.remove).toEqual([dupe, moved, gone]);
    expect(plan.create).toEqual([b]);
    expect(plan.unusedCalendars).toEqual(["course:cs169a"]);
  });

  it("plans one event per task even if a task is listed twice", () => {
    const plan = planSync([a, a, b], []);
    expect(plan.create).toEqual([a, b]);
  });
});
