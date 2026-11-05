import type { Course } from "./types.js";

/** A semester or quarter, e.g. Fall 2026. */
export interface Term {
  season: "Winter" | "Spring" | "Summer" | "Fall";
  year: number;
}

const SEASONS: Term["season"][] = ["Winter", "Spring", "Summer", "Fall"];

/** Roughly when each term starts on Berkeley's calendar, as [month (0-11), day]. */
const STARTS: Record<Term["season"], [number, number]> = {
  Winter: [0, 1],
  Spring: [0, 10],
  Summer: [4, 20],
  Fall: [7, 15],
};

const SEASON_WORDS: Record<string, Term["season"]> = {
  winter: "Winter", wi: "Winter",
  spring: "Spring", sp: "Spring",
  summer: "Summer", su: "Summer",
  fall: "Fall", fa: "Fall", autumn: "Fall",
};

/**
 * Finds a term in text, however a site writes it: "Fall 2026", "2026 Fall",
 * "Fall, 2026", "Fall Semester 2026", "Summer Session A 2026", "Spring
 * Quarter 2027", "Fall 26", "Fall26", "Fall '26", "FA26", or inside a
 * longer name like "CS 61C: Great Ideas, Spring 2026".
 */
export function parseTerm(text: string | null | undefined): Term | null {
  if (!text) return null;
  const words = "(winter|spring|summer|fall|autumn|wi|sp|su|fa)";
  const kind = "(?:[\\s,]+(?:semester|term|quarter|session(?:\\s+[a-z])?))?";
  const match =
    new RegExp(`\\b${words}${kind}[\\s,]*'?(\\d{4}|\\d{2})\\b`, "i").exec(text) ??
    new RegExp(`\\b(\\d{4})[\\s,]+${words}\\b`, "i").exec(text);
  if (!match) return null;
  const [word, year] = /^\d/.test(match[1]!) ? [match[2]!, match[1]!] : [match[1]!, match[2]!];
  return { season: SEASON_WORDS[word.toLowerCase()]!, year: year.length === 2 ? 2000 + Number(year) : Number(year) };
}

const order = (term: Term) => term.year * SEASONS.length + SEASONS.indexOf(term.season);

export const termName = (term: Term) => `${term.season} ${term.year}`;

/** Sorts newest term first; unknown terms go last. */
export function newestFirst(a: Term | null, b: Term | null): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return order(b) - order(a);
}

/** The term going on at `now`: the latest one that has started. */
export function currentTerm(now: number): Term {
  const year = new Date(now).getUTCFullYear();
  for (const season of [...SEASONS].reverse()) {
    const [month, day] = STARTS[season];
    if (now >= Date.UTC(year, month, day)) return { season, year };
  }
  return { season: "Fall", year: year - 1 };
}

/** A course's term, from what the platform says or from its name. */
export function courseTerm(course: Course): Term | null {
  return parseTerm(course.term) ?? parseTerm(course.name) ?? parseTerm(course.code);
}

/** The newest term among copies of one course on different sites. */
export function newestTerm(courses: Course[]): Term | null {
  let newest: Term | null = null;
  for (const course of courses) {
    const term = courseTerm(course);
    if (term && (!newest || order(term) > order(newest))) newest = term;
  }
  return newest;
}

/**
 * True for a term before the current one. Upcoming terms, and courses whose
 * term isn't known, count as current, so nothing is hidden by mistake.
 */
export function isEarlierTerm(term: Term | null, now: number): boolean {
  return term !== null && order(term) < order(currentTerm(now));
}
