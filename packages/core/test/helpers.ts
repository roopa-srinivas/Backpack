import type { Assignment, Platform } from "../src/index.js";

const COURSES = {
  canvas: { platform: "canvas", id: "1500", name: "COMPSCI 169A - LEC 001", code: "COMPSCI 169A" },
  gradescope: { platform: "gradescope", id: "880", name: "CS 169A Fall 2026" },
  prairielearn: { platform: "prairielearn", id: "77", name: "CS 169A: Software Engineering" },
  flextensions: { platform: "flextensions", id: "31", name: "COMPSCI 169A - LEC 001", code: "COMPSCI 169A", term: "Fall 2026", sameAs: "canvas:1500" },
} as const;

let nextId = 1;

export function assignment(platform: Platform, overrides: Partial<Assignment> = {}): Assignment {
  const id = String(nextId++);
  return {
    platform,
    id,
    course: { ...COURSES[platform] },
    title: "Homework 3: Ruby Intro",
    url: `https://${platform}.example/${id}`,
    dueAt: "2026-10-24T06:59:00Z", // Fri Oct 23, 11:59 PM in Berkeley
    submitted: false,
    kind: "assignment",
    points: null,
    ...overrides,
  };
}
