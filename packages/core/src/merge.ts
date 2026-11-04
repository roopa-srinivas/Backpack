import { identifyCourse, type CourseIdentity } from "./courses.js";
import type { Assignment, Platform, Task } from "./types.js";

/** Platforms students submit on come first: their titles and due dates win. */
export const DEFAULT_PLATFORM_PRIORITY: Platform[] = ["gradescope", "prairielearn", "canvas"];

/** Copies of one assignment are expected within this window of each other. */
const SAME_DUE_WINDOW_MS = 36 * 60 * 60 * 1000;

const WORD_SWAPS: [RegExp, string][] = [
  [/\bhomework\b/g, "hw"],
  [/\bproject\b/g, "proj"],
  [/\blaboratory\b/g, "lab"],
  [/\bassignment\b/g, "hw"],
  [/\bproblem set\b/g, "hw"],
  [/\bpset\b/g, "hw"],
  [/\bps(?=\s*\d)/g, "hw"],
  [/\bdiscussion\b/g, "disc"],
  [/\bmidterm\b/g, "mt"],
];

/** "Homework 03: Ruby Intro" -> "hw3 ruby intro". */
export function normalizeTitle(title: string): string {
  let s = title.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  for (const [pattern, replacement] of WORD_SWAPS) s = s.replace(pattern, replacement);
  return s
    .replace(/\b(hw|proj|lab|disc|mt|quiz)\s*0*(\d+)/g, "$1$2") // "hw 03", "hw03" -> "hw3"
    .replace(/\b0+(\d)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter(Boolean));
}

/** Numbered labels like "hw3" or "proj2a"; two copies must agree on them. */
function labels(normalized: string): string[] {
  return normalized.split(" ").filter((t) => /^(hw|proj|lab|disc|mt|quiz)\d+[a-z]?$/.test(t)).sort();
}

export function titlesMatch(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return true;
  const la = labels(na);
  const lb = labels(nb);
  if (la.length > 0 || lb.length > 0) {
    // "HW 3" and "Homework 3: Ruby" match; "HW 3" and "HW 4" never do.
    return la.length > 0 && la.join() === lb.join();
  }
  const ta = tokens(na);
  const tb = tokens(nb);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared) >= 0.6;
}

/** Same numbered label ("hw3") or the same title once normalized: safe to match without a due date. */
function titlesMatchExactly(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  const la = labels(na);
  return na === nb || (la.length > 0 && la.join() === labels(nb).join());
}

function dueClose(a: string, b: string): boolean {
  return Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_DUE_WINDOW_MS;
}

/**
 * Whether two copies are the same piece of work. When one copy has no due
 * date (a placeholder, or a site that hides past deadlines), the titles have
 * to agree exactly, since there's no date to back the match up.
 */
function sameWork(a: Assignment, b: Assignment): boolean {
  if (a.dueAt && b.dueAt) return titlesMatch(a.title, b.title) && dueClose(a.dueAt, b.dueAt);
  return titlesMatchExactly(a.title, b.title);
}

/** The course on its own platform a copy came from, e.g. "canvas:1500". */
const platformCourse = (a: Assignment) => `${a.course.platform}:${a.course.id}`;

/**
 * A reader can list one assignment twice (the same platform and id); keep one
 * copy, filling in anything the other copy knew.
 */
function dropRepeats(assignments: Assignment[]): Assignment[] {
  const byId = new Map<string, Assignment>();
  for (const a of assignments) {
    const id = `${a.platform}:${a.id}`;
    const seen = byId.get(id);
    byId.set(
      id,
      seen
        ? { ...seen, dueAt: seen.dueAt ?? a.dueAt, submitted: seen.submitted || a.submitted, points: seen.points ?? a.points ?? null }
        : a,
    );
  }
  return [...byId.values()];
}

/** Copies that share at least this many dated assignments are the same course. */
const LINKING_MATCHES = 2;

/**
 * Works out each platform course's identity. Courses with no recognizable
 * code ("Robotics" on Gradescope) are linked to the course they share
 * assignments with, so their copies still merge. Two courses that both have
 * codes are never linked this way: CS 61A and CS 61B can both have a "HW 3"
 * due the same Friday.
 */
function courseIdentities(assignments: Assignment[], aliases: Record<string, string>): Map<string, CourseIdentity> {
  const identities = new Map<string, CourseIdentity>();
  const byCourse = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const key = platformCourse(a);
    if (!identities.has(key)) identities.set(key, identifyCourse(a.course, aliases));
    byCourse.set(key, [...(byCourse.get(key) ?? []), a]);
  }
  // identifyCourse falls back to "platform:id" when it finds no code.
  const unknown = (identity: CourseIdentity) => identity.key.includes(":");

  const linked = new Map(identities);
  for (const [course, identity] of identities) {
    if (!unknown(identity)) continue;
    const mine = byCourse.get(course)!.filter((a) => a.dueAt);
    const counts = new Map<string, number>();
    for (const [other, otherIdentity] of identities) {
      if (other === course || otherIdentity.key === identity.key) continue;
      // Between two unknown courses, only the later key links to the earlier, so they meet in one place.
      if (unknown(otherIdentity) && otherIdentity.key > identity.key) continue;
      const theirs = byCourse.get(other)!;
      const shared = mine.filter((a) => theirs.some((b) => b.dueAt && sameWork(a, b))).length;
      counts.set(otherIdentity.key, (counts.get(otherIdentity.key) ?? 0) + shared);
    }
    const [best, runnerUp] = [...counts].sort((x, y) => y[1] - x[1]);
    if (best && best[1] >= LINKING_MATCHES && (!runnerUp || best[1] > runnerUp[1])) {
      linked.set(course, [...identities.values()].find((i) => i.key === best[0])!);
    }
  }
  return linked;
}

export interface MergeOptions {
  priority?: Platform[];
  courseAliases?: Record<string, string>;
}

/**
 * Groups copies of the same assignment into tasks, so each piece of work is
 * on the calendar once however many sites list it. Copies merge when they're
 * in the same course, with matching titles and due dates within 36 hours.
 * Copies from one course site never merge with each other (two "Reading
 * Response"s there are two pieces of work), but copies from two sites of the
 * same class on one platform do, like a bCourses lecture site and lab site.
 *
 * Readers for new platforms only need stable ids that are unique on their
 * platform; repeats of an id are dropped here.
 */
export function mergeAssignments(assignments: Assignment[], options: MergeOptions = {}): Task[] {
  const priority = options.priority ?? DEFAULT_PLATFORM_PRIORITY;
  const rank = (p: Platform) => {
    const i = priority.indexOf(p);
    return i === -1 ? priority.length : i;
  };
  const unique = dropRepeats(assignments);
  const courses = courseIdentities(unique, options.courseAliases ?? {});
  // Highest-priority platforms first, so they seed each group.
  const sorted = [...unique].sort(
    (a, b) => rank(a.platform) - rank(b.platform) || a.platform.localeCompare(b.platform) || a.id.localeCompare(b.id),
  );

  const groups: { courseKey: string; courseLabel: string; items: Assignment[] }[] = [];
  for (const assignment of sorted) {
    const course = courses.get(platformCourse(assignment))!;
    const group = groups.find(
      (g) =>
        g.courseKey === course.key &&
        !g.items.some((i) => platformCourse(i) === platformCourse(assignment)) &&
        sameWork(g.items[0]!, assignment),
    );
    if (group) group.items.push(assignment);
    else groups.push({ courseKey: course.key, courseLabel: course.label, items: [assignment] });
  }

  return groups.map(({ courseKey, courseLabel, items }) => {
    const lead = items[0]!;
    return {
      // Keyed by the lead copy: a Canvas copy appearing or vanishing leaves the key alone.
      key: `${lead.platform}:${lead.id}`,
      courseKey,
      courseLabel,
      title: lead.title,
      dueAt: lead.dueAt ?? items.find((i) => i.dueAt)?.dueAt ?? null,
      submitted: items.some((i) => i.submitted),
      kind: lead.kind,
      points: items.find((i) => i.points != null)?.points ?? null,
      sources: items,
    };
  });
}
