import { describe, expect, it } from "vitest";
import {
  defaultSettings,
  dueOptions,
  dueReminders,
  formatDue,
  fromLocalInput,
  mergeAssignments,
  REMIND_EARLY_MS,
  resolveDueDates,
  toLocalInput,
  unshown,
  type DueQuestion,
} from "../src/index.js";
import { assignment } from "./helpers.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const FRI = "2026-10-24T06:59:00Z";
const SAT = "2026-10-24T20:00:00Z";
const settings = defaultSettings("America/Los_Angeles");

describe("dueOptions", () => {
  it("lists each different deadline once, with the sites giving it, earliest first", () => {
    const [task] = mergeAssignments([
      assignment("canvas", { dueAt: SAT }),
      assignment("gradescope", { dueAt: FRI }),
      assignment("prairielearn", { dueAt: SAT }),
    ]);
    expect(dueOptions(task!)).toEqual([
      { dueAt: FRI, platforms: ["gradescope"] },
      { dueAt: SAT, platforms: ["prairielearn", "canvas"] },
    ]);
  });

  it("counts times a few minutes apart as the same (11:59 PM and midnight)", () => {
    const [task] = mergeAssignments([assignment("canvas", { dueAt: "2026-10-24T07:00:00Z" }), assignment("gradescope", { dueAt: FRI })]);
    expect(dueOptions(task!)).toHaveLength(1);
  });

  it("doesn't count a site still showing the date an approved extension replaced", () => {
    const [task] = mergeAssignments([
      assignment("gradescope", { dueAt: FRI }),
      assignment("flextensions", { dueAt: SAT, extension: { status: "approved", originalDueAt: FRI } }),
    ]);
    expect(dueOptions(task!)).toEqual([{ dueAt: SAT, platforms: ["flextensions"] }]);
  });
});

describe("resolveDueDates", () => {
  const tasks = () => mergeAssignments([assignment("canvas", { dueAt: SAT }), assignment("gradescope", { dueAt: FRI })]);

  it("holds the calendar's date and asks once", () => {
    const list = tasks();
    const first = resolveDueDates(list, {}, { [list[0]!.key]: "2026-10-23T06:59:00Z" }, settings, NOW);
    expect(first.tasks[0]!.dueAt).toBe("2026-10-23T06:59:00Z");
    expect(first.fresh).toEqual([list[0]!.key]);
    const again = resolveDueDates(list, first.questions, {}, settings, NOW);
    expect(again.fresh).toEqual([]);
    expect(again.tasks[0]!.dueAt).toBe("2026-10-23T06:59:00Z");
  });

  it("uses the student's nickname for the class", () => {
    const named = { ...settings, courses: { cs169a: { label: "SWE" } } };
    expect(Object.values(resolveDueDates(tasks(), {}, {}, named, NOW).questions)[0]!.courseLabel).toBe("SWE");
  });

  it("forgets questions once every date is well past", () => {
    const list = tasks();
    const { questions } = resolveDueDates(list, {}, {}, settings, NOW);
    expect(Object.keys(questions)).toHaveLength(1);
    expect(resolveDueDates(list, questions, {}, settings, Date.parse("2026-11-05T12:00:00Z")).questions).toEqual({});
  });
});

describe("dueReminders", () => {
  const q = (remindAt: number): DueQuestion => ({
    taskKey: "k",
    courseLabel: "CS 169A",
    title: "HW 3",
    options: [],
    heldDueAt: null,
    answer: { kind: "later", remindAt },
    askedAt: NOW,
  });
  it("is due from a little before the reminder time", () => {
    expect(dueReminders({ k: q(NOW + REMIND_EARLY_MS + 1) }, NOW)).toEqual([]);
    expect(dueReminders({ k: q(NOW + REMIND_EARLY_MS) }, NOW)).toEqual(["k"]);
    expect(dueReminders({ k: { ...q(NOW), answer: { kind: "keep" } } }, NOW)).toEqual([]);
  });
});

describe("date and time fields", () => {
  it("round-trip through a time zone, across daylight saving", () => {
    expect(toLocalInput(Date.parse(FRI), "America/Los_Angeles")).toBe("2026-10-23T23:59");
    expect(fromLocalInput("2026-10-23T23:59", "America/Los_Angeles")).toBe(Date.parse(FRI));
    expect(fromLocalInput("2026-11-02T09:00", "America/Los_Angeles")).toBe(Date.parse("2026-11-02T17:00:00Z"));
    expect(fromLocalInput("", "America/Los_Angeles")).toBeNull();
    expect(formatDue(Date.parse(FRI), "America/Los_Angeles")).toBe("Fri, Oct 23, 11:59 PM");
  });
});

describe("unshown", () => {
  it("lists questions no one has seen yet, so each pops up once", () => {
    const list = mergeAssignments([assignment("canvas", { dueAt: SAT }), assignment("gradescope", { dueAt: FRI })]);
    const { questions } = resolveDueDates(list, {}, {}, settings, NOW);
    const key = list[0]!.key;
    expect(unshown(questions)).toEqual([key]);
    const seen = { [key]: { ...questions[key]!, shownAt: NOW } };
    expect(unshown(seen)).toEqual([]);
    // Still seen on the next sync, while the dates stay the same.
    expect(unshown(resolveDueDates(list, seen, {}, settings, NOW).questions)).toEqual([]);
  });
});
