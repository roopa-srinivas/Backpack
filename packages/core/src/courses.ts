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
  STATS: "STAT",
  MATHEMATICS: "MATH",
  DATA: "DATA",
  "COMP SCI": "CS",
  "COMPUTER SCIENCE": "CS",
  "DATA SCIENCE": "DATA",
};

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

  const [first] = courseCodes(course);
  if (first) return { key: first.key, label: first.label };
  // No recognizable code: fall back to the platform course itself.
  const label = (course.code || course.name).trim();
  return { key: `${course.platform}:${course.id}`, label };
}

/**
 * Section types in course names ("LEC 001", "DIS 101", "STD 101"). They're
 * only sections when a three-digit section number follows, so "ETH STD 21AC"
 * (Ethnic Studies) still reads as a course.
 */
const SECTION_WORDS = new Set(["LEC", "DIS", "LAB", "SEM", "SEC", "TUT", "STD", "IND", "GRP", "CLC", "WBL", "FLD", "COL", "REC", "SES", "VOL", "WOR"]);

/**
 * Words that sit before a number in course names without being a department:
 * terms written short ("Fall26", "FA26"), and everyday words ("Week 3",
 * "Part 2", "Section 101", "Room 310", "HW 3").
 */
const NOT_DEPARTMENTS = new Set([
  "FALL", "SPRING", "SUMMER", "WINTER", "AUTUMN", "FA", "SP", "SU", "WI", "SEMESTER", "SESSION", "TERM", "QUARTER", "YEAR",
  "WEEK", "WK", "PART", "PT", "UNIT", "SECTION", "SECT", "LECTURE", "CHAPTER", "CH", "GROUP", "TEAM", "ROOM", "RM",
  "MODULE", "LESSON", "TOPIC", "PHASE", "STAGE", "STEP", "ROUND", "GRADE", "CLASS", "PERIOD", "BLOCK", "VERSION", "VER",
  "LEVEL", "DAY", "HW", "HOMEWORK", "PROJECT", "PROJ", "QUIZ", "EXAM", "MIDTERM", "MT", "FINAL", "DISC", "DISCUSSION",
  "ASSIGNMENT", "PSET", "PS", "NO", "NUM", "NUMBER", "ID", "PAGE", "PG", "SLOT", "TRACK", "HALL", "BLDG", "OFFICE",
  "VOLUME", "COHORT", "TA", "GSI", "LAB", "LEC", "DIS", "SEM", "SEC", "TUT", "WORKSHOP", "TUTORIAL", "REVIEW",
  "SEMINAR", "RECITATION", "STUDIO", "CLINIC", "PRACTICUM", "BOOTCAMP", "ORIENTATION", "SECTIONS", "LABS",
]);

/** Small words that start a two-word match without being part of a department: "Intro to CS 61A". */
const LEADING_WORDS = new Set(["TO", "OF", "AND", "THE", "IN", "FOR", "AN", "ON", "WITH", "AT", "BY", "OR", "INTRO", "INTRODUCTION"]);

/**
 * A course code: a department (one word, or two like "EL ENG"), an optional
 * prefix letter (C cross-listed, H honors, R reading and composition, N and W
 * for summer and online), then a number with an optional letter suffix or
 * topic number: "COMPSCI 61A", "EECS C106A", "MATH H54", "ENGLISH R1A",
 * "COMPSCI 194-26", "INTEGBI 35AC", "CS 2110".
 */
const CODES = /\b([A-Z&]{2,12}(?: [A-Z&]{2,8})?)\s*([CHNRW])?(\d{1,4})((?:[A-Z]{1,2})|-[1-9]\d{0,2})?\b/g;

/** The department in a match, or null when the words before the number aren't one. */
function department(words: string, number: string): string | null {
  const parts = words.split(" ");
  const section = (word: string) => SECTION_WORDS.has(word) && /^\d{3}$/.test(number);
  const skip = (word: string) => NOT_DEPARTMENTS.has(word) || section(word);
  if (parts.length === 2) {
    const [first, second] = parts as [string, string];
    if (DEPARTMENT_ALIASES[words]) return DEPARTMENT_ALIASES[words];
    // The word right before the number decides: "Data Structures Part 2" isn't a course.
    if (skip(second)) return null;
    // "TO CS", "WEEK CS": the department is the second word.
    if (LEADING_WORDS.has(first) || skip(first)) return DEPARTMENT_ALIASES[second] ?? second;
    // Two-word departments end in a short abbreviation: "EL ENG", "MAT SCI", "ETH STD".
    if (second.length <= 4) return DEPARTMENT_ALIASES[`${first}${second}`] ?? words;
    return DEPARTMENT_ALIASES[second] ?? second;
  }
  if (skip(words) || LEADING_WORDS.has(words)) return null;
  return DEPARTMENT_ALIASES[words] ?? words;
}

export interface CourseCode extends CourseIdentity {
  /** The department, lowercase, e.g. "eecs". */
  dept: string;
  /** The number with any prefix letter and suffix, lowercase, e.g. "106a", "h54", "194-26". */
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
      const [, words, prefix, digits, suffix = ""] = match as unknown as [string, string, string | undefined, string, string | undefined];
      // "2026" is a year, not a course number.
      if (/^(19|20)\d\d$/.test(digits) && !suffix) continue;
      const dept = department(words, digits);
      if (!dept) continue;
      // The cross-listing C is dropped; honors and other prefixes are part of the number.
      const number = `${prefix && prefix !== "C" ? prefix : ""}${digits}${suffix}`;
      const label = `${dept} ${number}`;
      const key = label.toLowerCase().replace(/\s+/g, "");
      const crossListed = prefix === "C" || Boolean(codes.get(key)?.crossListed);
      codes.set(key, { key, label, dept: dept.toLowerCase(), number: number.toLowerCase(), crossListed });
    }
  }
  return [...codes.values()];
}

const SMALL_WORDS = new Set([
  "and", "the", "of", "to", "in", "for", "a", "an", "on", "with", "intro", "introduction",
  "fall", "spring", "summer", "winter", "autumn", "semester", "session", "term", "quarter", "lec", "dis", "lab", "sem",
]);

/**
 * The words of a course's title, without codes, terms or sections:
 * "EECS 106A: Introduction to Robotics, Fall 2026" -> {"robotics"}.
 */
export function courseTitleWords(course: Course): Set<string> {
  // Only real codes come out; "Data Structures Part 2" keeps "structures".
  const title = course.name
    .toUpperCase()
    .replace(CODES, (match, words: string, _prefix, digits: string) => (department(words, digits) ? " " : ` ${words} `))
    .toLowerCase();
  return new Set(title.split(/[^a-z]+/).filter((w) => w.length > 2 && !SMALL_WORDS.has(w)));
}
