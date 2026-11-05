import { describe, expect, it } from "vitest";
import { identifyCourse, mergeAssignments, normalizeTitle, titlesMatch } from "../src/index.js";
import { assignment } from "./helpers.js";

describe("identifyCourse", () => {
  it("lines up Berkeley catalog names with the short names course staff use", () => {
    const canvas = identifyCourse({ platform: "canvas", id: "1", name: "COMPSCI 169A - LEC 001", code: "COMPSCI 169A" });
    const gradescope = identifyCourse({ platform: "gradescope", id: "2", name: "CS 169A Fall 2026" });
    expect(canvas).toEqual({ key: "cs169a", label: "CS 169A" });
    expect(gradescope.key).toBe("cs169a");
  });

  it("drops the cross-listing C and handles two-word departments", () => {
    expect(identifyCourse({ platform: "canvas", id: "1", name: "EECS C106A Intro to Robotics" }).label).toBe("EECS 106A");
    expect(identifyCourse({ platform: "canvas", id: "1", name: "EL ENG 16A" }).label).toBe("EE 16A");
  });

  it("uses an alias the user pinned", () => {
    const course = { platform: "prairielearn" as const, id: "9", name: "Robotics Fall 2026" };
    expect(identifyCourse(course, { "prairielearn:9": "EECS 106A" })).toEqual({ key: "eecs106a", label: "EECS 106A" });
  });

  it("falls back to the platform course when there's no code", () => {
    expect(identifyCourse({ platform: "canvas", id: "4", name: "Writing Seminar" })).toEqual({
      key: "canvas:4",
      label: "Writing Seminar",
    });
  });
});

describe("titlesMatch", () => {
  it("matches the same numbered assignment written different ways", () => {
    expect(normalizeTitle("Homework 03: Ruby Intro")).toBe("hw3 ruby intro");
    expect(titlesMatch("HW 3", "Homework 3: Ruby Intro")).toBe(true);
    expect(titlesMatch("Project 2A", "Proj 2a - Checkpoint")).toBe(true);
  });

  it("never matches different numbers", () => {
    expect(titlesMatch("Homework 3", "Homework 4")).toBe(false);
    expect(titlesMatch("Lab 1", "Homework 1")).toBe(false);
  });

  it("compares unnumbered titles by shared words", () => {
    expect(titlesMatch("Final Essay Draft", "Final essay draft (upload)")).toBe(true);
    expect(titlesMatch("Final Essay Draft", "Reading Response")).toBe(false);
  });
});

describe("mergeAssignments", () => {
  it("merges a Canvas and Gradescope copy, preferring Gradescope's details", () => {
    const canvas = assignment("canvas", { title: "Homework 3", points: 10, submitted: true });
    const gradescope = assignment("gradescope", { title: "HW3: Ruby Intro", dueAt: "2026-10-24T07:00:00Z" });
    const [task, ...rest] = mergeAssignments([canvas, gradescope]);
    expect(rest).toEqual([]);
    expect(task).toMatchObject({
      key: `gradescope:${gradescope.id}`,
      courseKey: "cs169a",
      title: "HW3: Ruby Intro",
      dueAt: "2026-10-24T07:00:00Z",
      submitted: true,
      points: 10,
    });
    expect(task!.sources.map((s) => s.platform)).toEqual(["gradescope", "canvas"]);
  });

  it("keeps copies apart when due dates are far apart", () => {
    const tasks = mergeAssignments([
      assignment("canvas", { title: "Quiz", dueAt: "2026-10-01T07:00:00Z" }),
      assignment("gradescope", { title: "Quiz", dueAt: "2026-10-08T07:00:00Z" }),
    ]);
    expect(tasks).toHaveLength(2);
  });

  it("never merges two assignments from the same platform", () => {
    const tasks = mergeAssignments([assignment("canvas", { title: "Reading" }), assignment("canvas", { title: "Reading" })]);
    expect(tasks).toHaveLength(2);
  });

  it("never merges across courses", () => {
    const other = assignment("gradescope", { course: { platform: "gradescope", id: "5", name: "CS 61B" } });
    expect(mergeAssignments([assignment("canvas"), other])).toHaveLength(2);
  });

  it("merges all three platforms into one task", () => {
    const tasks = mergeAssignments([assignment("canvas"), assignment("prairielearn"), assignment("gradescope")]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.sources.map((s) => s.platform)).toEqual(["gradescope", "prairielearn", "canvas"]);
  });
});

describe("no repeated assignments", () => {
  const gradescopeCourse = (name: string, id = "880") => ({ platform: "gradescope" as const, id, name });
  const canvasCourse = (name: string, id: string, code?: string) => ({
    platform: "canvas" as const,
    id,
    name,
    ...(code ? { code } : {}),
  });

  it("matches numbers written with leading zeros or no space", () => {
    expect(titlesMatch("HW03", "Homework 3: Ruby Intro")).toBe(true);
    expect(titlesMatch("Lab01 - Setup", "Lab 1")).toBe(true);
    expect(titlesMatch("PS 4", "Problem Set 4")).toBe(true);
    expect(titlesMatch("Proj2A", "Project 2A Checkpoint")).toBe(true);
    expect(titlesMatch("HW03", "HW 30")).toBe(false);
  });

  it("keeps one copy when a reader lists the same assignment twice", () => {
    const first = assignment("gradescope", { id: "42", dueAt: null });
    const again = { ...first, dueAt: "2026-10-24T06:59:00Z", submitted: true };
    const tasks = mergeAssignments([first, again]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ key: "gradescope:42", dueAt: "2026-10-24T06:59:00Z", submitted: true });
  });

  it("merges one assignment posted on two bCourses sites for the same class", () => {
    const lecture = canvasCourse("COMPSCI 61A - LEC 001", "1500", "COMPSCI 61A");
    const lab = canvasCourse("COMPSCI 61A - LAB 012", "1501", "COMPSCI 61A");
    const tasks = mergeAssignments([
      assignment("canvas", { course: lecture, title: "Lab 3" }),
      assignment("canvas", { course: lab, title: "Lab 03: Recursion" }),
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.sources).toHaveLength(2);
  });

  it("merges a copy with no due date when the numbered title matches", () => {
    const tasks = mergeAssignments([
      assignment("canvas", { title: "Homework 3", dueAt: null, submitted: true }),
      assignment("gradescope", { title: "HW 3" }),
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ dueAt: "2026-10-24T06:59:00Z", submitted: true });
  });

  it("doesn't guess with a missing due date and a loosely matching title", () => {
    const tasks = mergeAssignments([
      assignment("canvas", { title: "Final essay draft (upload)", dueAt: null }),
      assignment("gradescope", { title: "Final Essay Draft" }),
    ]);
    expect(tasks).toHaveLength(2);
  });

  it("links a course with no code to the course it shares assignments with", () => {
    const robotics = gradescopeCourse("Robotics Fall 2026");
    const bcourses = canvasCourse("EECS C106A - LEC 001", "2100", "EECS C106A");
    const tasks = mergeAssignments([
      assignment("canvas", { course: bcourses, title: "Homework 1", dueAt: "2026-09-12T06:59:00Z" }),
      assignment("canvas", { course: bcourses, title: "Homework 2", dueAt: "2026-09-19T06:59:00Z" }),
      assignment("canvas", { course: bcourses, title: "Lab 2", dueAt: "2026-09-20T06:59:00Z" }),
      assignment("gradescope", { course: robotics, title: "HW 1", dueAt: "2026-09-12T06:59:00Z" }),
      assignment("gradescope", { course: robotics, title: "HW 2", dueAt: "2026-09-19T07:00:00Z" }),
      assignment("gradescope", { course: robotics, title: "Lab 2 Report", dueAt: "2026-09-20T06:59:00Z" }),
    ]);
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t.courseLabel === "EECS 106A" && t.sources.length === 2)).toBe(true);
  });

  it("links two courses that both lack a code to one course", () => {
    const tasks = mergeAssignments([
      assignment("canvas", { course: canvasCourse("Writing Seminar", "4"), title: "Essay 1", dueAt: "2026-09-12T06:59:00Z" }),
      assignment("canvas", { course: canvasCourse("Writing Seminar", "4"), title: "Essay 2", dueAt: "2026-09-26T06:59:00Z" }),
      assignment("gradescope", { course: gradescopeCourse("Seminar"), title: "Essay 1", dueAt: "2026-09-12T06:59:00Z" }),
      assignment("gradescope", { course: gradescopeCourse("Seminar"), title: "Essay 2", dueAt: "2026-09-26T06:59:00Z" }),
    ]);
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map((t) => t.courseKey)).size).toBe(1);
  });

  it("doesn't link courses on one shared assignment, or when two courses fit equally", () => {
    const robotics = gradescopeCourse("Robotics Fall 2026");
    const one = mergeAssignments([
      assignment("canvas", { course: canvasCourse("EECS C106A", "2100", "EECS C106A"), title: "Homework 1" }),
      assignment("gradescope", { course: robotics, title: "HW 1" }),
    ]);
    expect(one).toHaveLength(2);

    const twoFits = mergeAssignments([
      assignment("canvas", { course: canvasCourse("COMPSCI 61A", "1", "COMPSCI 61A"), title: "HW 1", dueAt: "2026-09-12T06:59:00Z" }),
      assignment("canvas", { course: canvasCourse("COMPSCI 61A", "1", "COMPSCI 61A"), title: "HW 2", dueAt: "2026-09-19T06:59:00Z" }),
      assignment("canvas", { course: canvasCourse("COMPSCI 61B", "2", "COMPSCI 61B"), title: "HW 1", dueAt: "2026-09-12T06:59:00Z" }),
      assignment("canvas", { course: canvasCourse("COMPSCI 61B", "2", "COMPSCI 61B"), title: "HW 2", dueAt: "2026-09-19T06:59:00Z" }),
      assignment("gradescope", { course: robotics, title: "HW 1", dueAt: "2026-09-12T06:59:00Z" }),
      assignment("gradescope", { course: robotics, title: "HW 2", dueAt: "2026-09-19T06:59:00Z" }),
    ]);
    // Ambiguous: Robotics stays its own course rather than being merged into the wrong one.
    expect(twoFits.filter((t) => t.sources.some((s) => s.course.id === "880"))).toHaveLength(2);
    expect(twoFits.every((t) => t.sources.length === 1)).toBe(true);
  });

  it("never links two courses that both have codes, even with matching homework", () => {
    const tasks = mergeAssignments([
      assignment("canvas", { course: canvasCourse("COMPSCI 61A", "1", "COMPSCI 61A"), title: "HW 1", dueAt: "2026-09-12T06:59:00Z" }),
      assignment("canvas", { course: canvasCourse("COMPSCI 61A", "1", "COMPSCI 61A"), title: "HW 2", dueAt: "2026-09-19T06:59:00Z" }),
      assignment("gradescope", { course: gradescopeCourse("CS 61B Fall 2026"), title: "HW 1", dueAt: "2026-09-12T06:59:00Z" }),
      assignment("gradescope", { course: gradescopeCourse("CS 61B Fall 2026"), title: "HW 2", dueAt: "2026-09-19T06:59:00Z" }),
    ]);
    expect(tasks).toHaveLength(4);
  });

  it("gives every task its own key, whatever the mix of sites", () => {
    const lab = canvasCourse("COMPSCI 169A - LAB 2", "1501", "COMPSCI 169A");
    const all = [
      assignment("canvas", { title: "HW03" }),
      assignment("canvas", { course: lab, title: "Homework 3" }),
      assignment("gradescope", { title: "HW 3: Ruby" }),
      assignment("prairielearn", { title: "HW3" }),
      assignment("canvas", { title: "Reading Response", dueAt: "2026-10-20T06:59:00Z" }),
      assignment("canvas", { title: "Reading Response", dueAt: "2026-10-20T06:59:00Z" }),
    ];
    const tasks = mergeAssignments([...all, all[2]!]);
    expect(tasks).toHaveLength(3);
    expect(new Set(tasks.map((t) => t.key)).size).toBe(tasks.length);
    expect(tasks[0]!.sources.map((s) => s.platform)).toEqual(["gradescope", "prairielearn", "canvas", "canvas"]);
  });
});
