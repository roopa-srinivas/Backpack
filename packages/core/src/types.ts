/** Where an assignment came from. */
export type Platform = "canvas" | "gradescope" | "prairielearn";

export const PLATFORM_NAMES: Record<Platform, string> = {
  canvas: "Canvas",
  gradescope: "Gradescope",
  prairielearn: "PrairieLearn",
};

export type AssignmentKind = "assignment" | "quiz" | "exam" | "discussion" | "lab" | "project" | "other";

export interface Course {
  platform: Platform;
  /** The platform's own id for the course. */
  id: string;
  /** Full name as the platform shows it, e.g. "COMPSCI 169A - LEC 001". */
  name: string;
  /** Short code when the platform has one, e.g. "COMPSCI 169A". */
  code?: string;
  /** The term as the platform names it, e.g. "Fall 2026", when it says. */
  term?: string;
}

/** One assignment as read from one platform, before merging. */
export interface Assignment {
  platform: Platform;
  /** Unique within the platform, e.g. the Canvas assignment id. */
  id: string;
  course: Course;
  title: string;
  url: string;
  /** ISO 8601 instant, or null when the platform lists no due date. */
  dueAt: string | null;
  submitted: boolean;
  kind: AssignmentKind;
  points?: number | null;
}

/**
 * One piece of work after merging: the same homework posted on Canvas and
 * Gradescope becomes a single task with both links.
 */
export interface Task {
  /** Stable across syncs; used to find the task's calendar event again. */
  key: string;
  courseKey: string;
  /** Short course label, e.g. "CS 169A". */
  courseLabel: string;
  title: string;
  dueAt: string | null;
  submitted: boolean;
  kind: AssignmentKind;
  points: number | null;
  /** Every platform copy, highest-priority platform first. */
  sources: Assignment[];
  /** Other names the course goes by, e.g. ME 106A for EECS 106A. */
  alsoKnownAs?: { key: string; label: string }[];
}
