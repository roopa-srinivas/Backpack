import type { Course } from "./types.js";

/**
 * Berkeley's catalog names departments one way (COMPSCI, ELENG) while course
 * staff use the short form (CS, EE). Both map to the short form so Canvas and
 * Gradescope copies of a course line up.
 */
const DEPARTMENT_ALIASES: Record<string, string> = {
  COMPSCI: "CS",
  ELENG: "EE",
  "EL ENG": "EE",
  BIOENG: "BIOE",
  "BIO ENG": "BIOE",
  MECENG: "ME",
  "MEC ENG": "ME",
  INDENG: "IEOR",
  "IND ENG": "IEOR",
  STATISTICS: "STAT",
  MATHEMATICS: "MATH",
  DATA: "DATA",
};

// Department letters (allowing one space, as in "EL ENG"), an optional
// cross-listing "C", then a course number with an optional letter suffix.
const COURSE_PATTERN = /\b([A-Z]{2,8}(?: [A-Z]{2,4})?)\s*C?(\d{1,3}[A-Z]{0,2})\b/;

export interface CourseIdentity {
  /** Lowercase, no spaces, e.g. "cs169a". Equal keys mean the same course. */
  key: string;
  /** Display label, e.g. "CS 169A". */
  label: string;
}

/**
 * Works out which course a platform's course is, from its code or name.
 * `aliases` lets the user pin a platform course to a key when the names
 * don't line up on their own (keyed by "platform:courseId").
 */
export function identifyCourse(course: Course, aliases: Record<string, string> = {}): CourseIdentity {
  const pinned = aliases[`${course.platform}:${course.id}`];
  if (pinned) return { key: pinned.toLowerCase().replace(/\s+/g, ""), label: pinned };

  for (const text of [course.code, course.name]) {
    if (!text) continue;
    const match = COURSE_PATTERN.exec(text.toUpperCase());
    if (!match) continue;
    const dept = DEPARTMENT_ALIASES[match[1]!] ?? match[1]!.replace(/\s+/g, "");
    const label = `${dept} ${match[2]}`;
    return { key: label.toLowerCase().replace(/\s+/g, ""), label };
  }
  // No recognizable code: fall back to the platform course itself.
  const label = (course.code || course.name).trim();
  return { key: `${course.platform}:${course.id}`, label };
}
