import { describe, expect, it } from "vitest";
import {
  assignCourseColors,
  buildEvents,
  addCourseToTitle,
  COURSE_PALETTE,
  defaultSettings,
  dropCourseFromTitle,
  switchCalendars,
  nearestEventColor,
  textColorOn,
  mergeAssignments,
  planSync,
  renderTitle,
  type Settings,
} from "../src/index.js";
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

describe("personalizing", () => {
  const event = (overrides: Parameters<typeof assignment>[1], custom: Partial<Settings>, now = NOW) =>
    buildEvents(mergeAssignments([assignment("gradescope", overrides)]), settings(custom), now)[0]!;
  const courses = { cs169a: { color: "7" as const } };

  it("colors events by course, unless the student chose no color", () => {
    expect(event({}, { courses }).body.colorId).toBe("7");
    expect(event({}, { courses: { cs169a: { color: null } } }).body.colorId).toBeUndefined();
  });

  it("lets a kind's color win over the course's", () => {
    const kinds = { exam: { color: "11" as const } };
    expect(event({ title: "Midterm 1", kind: "exam" }, { courses, kinds }).body.colorId).toBe("11");
    expect(event({ kind: "assignment" }, { courses, kinds }).body.colorId).toBe("7");
  });

  it("lets where the work stands win over everything", () => {
    const statusColors = { submitted: "8" as const, dueSoon: "11" as const, dueSoonHours: 24 };
    const kinds = { exam: { color: "3" as const } };
    const due = "2026-10-24T06:59:00Z";
    // Done: grey, even for an exam in a colored course.
    expect(event({ dueAt: due, submitted: true, kind: "exam" }, { courses, kinds, statusColors }).body.colorId).toBe("8");
    // 30 hours out: not due soon yet.
    expect(event({ dueAt: due }, { courses, statusColors }, Date.parse(due) - 30 * 3_600_000).body.colorId).toBe("7");
    // 20 hours out, and overdue: due soon.
    expect(event({ dueAt: due }, { courses, statusColors }, Date.parse(due) - 20 * 3_600_000).body.colorId).toBe("11");
    expect(event({ dueAt: due }, { courses, statusColors }, Date.parse(due) + 3_600_000).body.colorId).toBe("11");
    // Submitted work isn't "due soon".
    const doneSoon = event({ dueAt: due, submitted: true }, { courses, statusColors: { dueSoon: "11", dueSoonHours: 24 } }, Date.parse(due) - 3_600_000);
    expect(doneSoon.body.colorId).toBe("7");
  });

  it("puts a kind's emoji before the title, after the check mark", () => {
    const kinds = { exam: { emoji: "🎯" } };
    expect(event({ title: "Midterm 1", kind: "exam" }, { kinds }).body.summary).toBe("🎯 CS 169A · Midterm 1");
    expect(event({ title: "Midterm 1", kind: "exam", submitted: true }, { kinds }).body.summary).toBe("✓ 🎯 CS 169A · Midterm 1");
    expect(event({ kind: "assignment" }, { kinds }).body.summary).toBe("CS 169A · Homework 3: Ruby Intro");
  });

  it("uses a kind's own reminders, or none, instead of the general ones", () => {
    const kinds = { exam: { reminders: [7 * 1440, 1440] }, discussion: { reminders: [] } };
    const minutes = (e: ReturnType<typeof event>) => e.body.reminders.overrides.map((o) => o.minutes);
    expect(minutes(event({ kind: "exam" }, { kinds }))).toEqual([10080, 1440]);
    expect(minutes(event({ kind: "discussion" }, { kinds }))).toEqual([]);
    expect(minutes(event({ kind: "lab" }, { kinds }))).toEqual([1440, 120]);
  });

  it("uses any color exactly on a class's own calendar, and the nearest Google color elsewhere", () => {
    const custom = { cs169a: { color: "#ff6f61" as const } }; // coral
    const shared = event({}, { courses: custom });
    expect(shared.body.colorId).toBe(nearestEventColor("#ff6f61"));
    expect(shared.calendarColor).toBeUndefined();

    const own = event({}, { courses: custom, calendars: "perCourse" });
    expect(own.body.colorId).toBeUndefined(); // the event takes the calendar's exact color
    expect(own.calendarColor).toBe("#ff6f61");

    const google = event({}, { courses, calendars: "perCourse" });
    expect(google.body.colorId).toBe("7");
    expect(google.calendarColor).toBe("#039BE5");
  });

  it("finds the nearest Google color and readable text", () => {
    expect(nearestEventColor("#039BE5")).toBe("7");
    expect(nearestEventColor("#ff0000")).toBe("11");
    expect(nearestEventColor("#0b8043")).toBe("10");
    expect(textColorOn("#F6BF26")).toBe("#1d1d1d");
    expect(textColorOn("#3F51B5")).toBe("#ffffff");
  });

  it("gives new courses distinct colors and leaves chosen ones alone", () => {
    const start = settings({ courses: { cs61a: { color: COURSE_PALETTE[0]! }, cs70: { color: null } } });
    const next = assignCourseColors(start, ["cs61a", "cs70", "cs169a", "data100", "cs169a"])!;
    expect(next.courses.cs61a!.color).toBe(COURSE_PALETTE[0]);
    expect(next.courses.cs70!.color).toBeNull();
    const fresh = [next.courses.cs169a!.color, next.courses.data100!.color];
    expect(new Set([COURSE_PALETTE[0], ...fresh]).size).toBe(3);
    expect(assignCourseColors(next, ["cs61a", "cs169a"])).toBeNull();
  });

  it("only counts the courses being colored, so old ones don't crowd out this term's", () => {
    // Every color is taken by earlier semesters' classes.
    const old = Object.fromEntries(COURSE_PALETTE.map((color, i) => [`old${i}`, { color }]));
    const next = assignCourseColors(settings({ courses: old }), ["cs61a", "cs70"])!;
    expect(next.courses.cs61a!.color).toBe(COURSE_PALETTE[0]);
    expect(next.courses.cs70!.color).toBe(COURSE_PALETTE[1]);
  });

  it("reuses colors once there are more courses than colors", () => {
    const keys = Array.from({ length: COURSE_PALETTE.length + 2 }, (_, i) => `c${String(i).padStart(2, "0")}`);
    const next = assignCourseColors(settings(), keys)!;
    expect(keys.every((k) => next.courses[k]!.color)).toBe(true);
    expect(new Set(keys.map((k) => next.courses[k]!.color)).size).toBe(COURSE_PALETTE.length);
  });
});

describe("class name in titles and notes", () => {
  it("puts the class in the event's notes", () => {
    const [event] = buildEvents(mergeAssignments([assignment("gradescope")]), settings({ titleTemplate: "{title}" }), NOW);
    expect(event!.body.summary).toBe("Homework 3: Ruby Intro");
    expect(event!.body.description.split("\n")[0]).toBe("Class: CS 169A");
    const renamed = buildEvents(mergeAssignments([assignment("gradescope")]), settings({ courses: { cs169a: { label: "Software Eng" } } }), NOW);
    expect(renamed[0]!.body.description.split("\n")[0]).toBe("Class: Software Eng");
  });

  it("takes the class out of a title template and puts it back", () => {
    expect(dropCourseFromTitle("{course} · {title}")).toBe("{title}");
    expect(dropCourseFromTitle("{title} ({course})")).toBe("{title}");
    expect(dropCourseFromTitle("{title} - {course}")).toBe("{title}");
    expect(dropCourseFromTitle("{course}: {title} {points}")).toBe("{title} {points}");
    expect(dropCourseFromTitle("{course}")).toBe("{title}");
    expect(addCourseToTitle("{title}")).toBe("{course} · {title}");
    expect(addCourseToTitle("{course} · {title}")).toBe("{course} · {title}");
  });

  it("drops the class from titles when each class gets its own calendar, and brings it back after", () => {
    const own = switchCalendars(settings(), "perCourse");
    expect(own).toMatchObject({ calendars: "perCourse", titleTemplate: "{title}" });
    expect(switchCalendars(own, "single")).toMatchObject({ calendars: "single", titleTemplate: "{course} · {title}" });
  });
});
