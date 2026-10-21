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
