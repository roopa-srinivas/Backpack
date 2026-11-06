/** Where an assignment came from. */
export type Platform = "canvas" | "gradescope" | "prairielearn" | "flextensions";

export const PLATFORM_NAMES: Record<Platform, string> = {
  canvas: "Canvas",
  gradescope: "Gradescope",
  prairielearn: "PrairieLearn",
  flextensions: "Flextensions",
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
  /** The same course on another platform, when this one says which: "canvas:1500". */
  sameAs?: string;
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
  /**
   * Whether work is turned in at `url`: "here", "tool" (through another site
   * opened inside this one, like a Gradescope assignment in bCourses), or
   * "elsewhere" (a placeholder for a grade, work on paper, an extension
   * form). Unset means "here".
   */
  submitAt?: "here" | "tool" | "elsewhere";
  /** The same assignment on another platform, when this copy says which: "canvas:4521". */
  sameAs?: string;
  /**
   * An extension the student asked for. When it's approved, `dueAt` is the
   * new deadline and `originalDueAt` the old one.
   */
  extension?: { status: "approved" | "pending"; originalDueAt: string | null };
  /**
   * Deadlines this copy showed on earlier reads, oldest first. Copies that
   * agreed before still match after one site moves the date.
   */
  earlierDueDates?: string[];
  /** When Backpack saw this copy's deadline move (ms since 1970). */
  dueMovedAt?: number;
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
  /** An extension one of the copies knows about; `dueAt` already includes an approved one. */
  extension?: { status: "approved" | "pending"; originalDueAt: string | null };
  /** Other names the course goes by, e.g. ME 106A for EECS 106A. */
  alsoKnownAs?: { key: string; label: string }[];
}
