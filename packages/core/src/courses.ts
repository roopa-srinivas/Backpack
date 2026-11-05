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

/** Labels in course names that aren't departments, like the "LEC" in "LEC 001". */
const NOT_DEPARTMENTS = new Set(["LEC", "DIS", "LAB", "SEM", "SEC", "TUT", "STD", "IND", "GRP", "CLC", "WBL", "FLD", "COL", "REC", "SES", "VOL"]);

const CODES = /\b([A-Z]{2,8}(?: [A-Z]{2,4})?)\s*(C)?(\d{1,3}[A-Z]{0,2})\b/g;

export interface CourseCode extends CourseIdentity {
  /** The number with its letter, lowercase, e.g. "106a". */
  number: string;
  /** Written with Berkeley's cross-listing C, as in "EECS C106A". */
  crossListed: boolean;
}

/**
 * Every course code in a course's code and name. A cross-listed class can
 * show several: "EECS C106A/MEC ENG C106A - LEC 001" is both EECS 106A and
 * ME 106A.
 */
export function courseCodes(course: Course): CourseCode[] {
  const codes = new Map<string, CourseCode>();
  for (const text of [course.code, course.name]) {
    if (!text) continue;
    for (const match of text.toUpperCase().matchAll(CODES)) {
      if (NOT_DEPARTMENTS.has(match[1]!)) continue;
      const dept = DEPARTMENT_ALIASES[match[1]!] ?? match[1]!.replace(/\s+/g, "");
      const label = `${dept} ${match[3]}`;
      const key = label.toLowerCase().replace(/\s+/g, "");
      const crossListed = Boolean(match[2]) || Boolean(codes.get(key)?.crossListed);
      codes.set(key, { key, label, number: match[3]!.toLowerCase(), crossListed });
    }
  }
  return [...codes.values()];
}

const SMALL_WORDS = new Set(["and", "the", "of", "to", "in", "for", "a", "an", "on", "with", "intro", "introduction"]);

/**
 * The words of a course's title, without codes, terms or sections:
 * "EECS 106A: Introduction to Robotics, Fall 2026" -> {"robotics"}.
 */
export function courseTitleWords(course: Course): Set<string> {
  const title = course.name
    .toUpperCase()
    .replace(CODES, " ")
    .replace(/\b(WINTER|SPRING|SUMMER|FALL|AUTUMN)\s+\d{4}\b/g, " ")
    .toLowerCase();
  return new Set(title.split(/[^a-z]+/).filter((w) => w.length > 2 && !SMALL_WORDS.has(w)));
}
