import { courseCodes, courseTitleWords, identifyCourse, type CourseIdentity } from "./courses.js";
import { courseTerm, type Term } from "./terms.js";
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

/** A course's identity, plus the other names it goes by once linked. */
export interface LinkedCourse extends CourseIdentity {
  alsoKnownAs: CourseIdentity[];
}

/** Two classes whose titles both say something and share no word are different classes. */
function titlesConflict(a: Set<string> | undefined, b: Set<string> | undefined): boolean {
  return Boolean(a && b && a.size >= 2 && b.size >= 2 && ![...a].some((w) => b.has(w)));
}

/**
 * Disjoint sets over course keys, carrying each group's title words. Joins
 * Backpack makes on its own are refused when the titles disagree ("User
 * Interface Design" and "Software Engineering"), whatever the codes suggest;
 * joins the student asked for always happen.
 */
class Groups {
  private parent = new Map<string, string>();
  private titles = new Map<string, Set<string>>();
  find(key: string): string {
    let root = key;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(key, root);
    return root;
  }
  addTitle(key: string, words: Set<string>) {
    const root = this.find(key);
    this.titles.set(root, new Set([...(this.titles.get(root) ?? []), ...words]));
  }
  join(a: string, b: string, { force = false } = {}) {
    const [ra, rb] = [this.find(a), this.find(b)];
    if (ra === rb) return;
    if (!force && titlesConflict(this.titles.get(ra), this.titles.get(rb))) return;
    this.parent.set(ra, rb);
    this.titles.set(rb, new Set([...(this.titles.get(ra) ?? []), ...(this.titles.get(rb) ?? [])]));
  }
}

/** Title words too common to say two courses are the same. */
const GENERIC_TITLE_WORDS = new Set([
  "seminar", "topics", "special", "selected", "research", "independent", "study", "studies", "directed", "group",
  "discussion", "lab", "laboratory", "section", "honors", "freshman", "sophomore", "colloquium", "workshop", "course",
]);

/** Whether two course titles name the same class: mostly the same words, and not just a generic one. */
function titlesAgree(a: Set<string>, b: Set<string>): boolean {
  const shared = [...a].filter((w) => b.has(w));
  if (!shared.length || shared.length / (a.size + b.size - shared.length) < 0.6) return false;
  return shared.length >= 2 || !GENERIC_TITLE_WORDS.has(shared[0]!);
}

/**
 * Works out which platform courses are the same class, and what to call it.
 * Courses are the same class when:
 *
 * - they have the same code (COMPSCI 169A and CS 169A both read as CS 169A);
 * - one name lists both codes, as cross-listed classes do ("EECS C106A/MEC
 *   ENG C106A");
 * - they have the same number in the same term and one is marked as
 *   cross-listed (EECS C106A and ME 106A), or their titles match
 *   ("Introduction to Robotics");
 * - one is the other's number without its letter, in the same department
 *   and term (CS 169 and CS 169A), and no other lettered version is around;
 * - their numbers match in the same term and one department is the other
 *   written short (PHYS 7A and PHYSICS 7A, EE 16A and EECS 16A);
 * - one has no code at all ("Robotics" on Gradescope) and it shares
 *   assignments with exactly one course;
 * - the student said so (`merges`).
 *
 * Matching homework alone never joins two courses with codes: CHEM 1A and
 * MATH 1A can both have an "HW 1" due every Friday. And none of these joins
 * happens between courses whose titles disagree.
 */
function courseIdentities(
  assignments: Assignment[],
  aliases: Record<string, string>,
  merges: Record<string, string>,
): Map<string, LinkedCourse> {
  const identities = new Map<string, CourseIdentity>();
  const byCourse = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const key = platformCourse(a);
    if (!identities.has(key)) identities.set(key, identifyCourse(a.course, aliases));
    byCourse.set(key, [...(byCourse.get(key) ?? []), a]);
  }
  // identifyCourse falls back to "platform:id" when it finds no code.
  const unknown = (identity: CourseIdentity) => identity.key.includes(":");
  const groups = new Groups();
  const labels = new Map<string, string>();
  for (const identity of identities.values()) labels.set(identity.key, identity.label);

  // What each course key is known by, across all its platform courses.
  interface KeyInfo {
    dept: string | null;
    number: string | null;
    crossListed: boolean;
    title: Set<string>;
    term: Term | null;
  }
  const info = new Map<string, KeyInfo>();
  const codesOf = new Map<string, ReturnType<typeof courseCodes>>();
  for (const [course, identity] of identities) {
    const sample = byCourse.get(course)![0]!.course;
    const pinned = Boolean(aliases[`${sample.platform}:${sample.id}`]);
    const codes = pinned ? [] : courseCodes(sample);
    codesOf.set(course, codes);
    const mine = codes.find((c) => c.key === identity.key);
    const known = info.get(identity.key);
    info.set(identity.key, {
      dept: mine?.dept ?? known?.dept ?? null,
      number: mine?.number ?? known?.number ?? null,
      crossListed: Boolean(known?.crossListed) || codes.some((c) => c.crossListed),
      title: new Set([...(known?.title ?? []), ...courseTitleWords(sample)]),
      term: known?.term ?? courseTerm(sample),
    });
  }
  for (const [key, { title }] of info) groups.addTitle(key, title);

  // Codes listed together in one name are one class when they're the same
  // number ("EECS C106A/MEC ENG C106A") or one adds a letter ("CS 169" and
  // "CS169A"). Other pairs, like CS 61A and CS 88 sharing a site, stay apart.
  const sameNumber = (a: string, b: string) => a === b || (/^\d+$/.test(a) && new RegExp(`^${a}[a-z]$`).test(b));
  for (const [course, identity] of identities) {
    const codes = codesOf.get(course)!;
    const mine = codes.find((c) => c.key === identity.key);
    for (const code of codes) {
      if (!mine || !(sameNumber(code.number, mine.number) || sameNumber(mine.number, code.number))) continue;
      if (!labels.has(code.key)) labels.set(code.key, code.label);
      groups.join(code.key, identity.key);
    }
  }

  const keyed = [...info].filter(([, i]) => i.number);
  const sameTerm = (a: KeyInfo, b: KeyInfo) =>
    !a.term || !b.term || (a.term.season === b.term.season && a.term.year === b.term.year);
  const department = (key: string, number: string) => key.slice(0, key.length - number.length);
  const shortFor = (a: string | null, b: string | null) =>
    Boolean(a && b && a !== b && Math.min(a.length, b.length) >= 2 && (a.startsWith(b) || b.startsWith(a)));

  // Same number, different department: cross-listed, the same title, or one
  // department written short (PHYS / PHYSICS, EE / EECS).
  for (const [i, [keyA, a]] of keyed.entries()) {
    for (const [keyB, b] of keyed.slice(i + 1)) {
      if (keyA === keyB || a.number !== b.number || !sameTerm(a, b)) continue;
      if (a.crossListed || b.crossListed || titlesAgree(a.title, b.title) || shortFor(a.dept, b.dept)) groups.join(keyA, keyB);
    }
  }

  // A number with and without its letter, in one department: CS 169 on one
  // site, CS 169A on another. Not when several lettered versions are around
  // (169A and 169L), and never between letters (MATH 1A and MATH 1B).
  for (const [bareKey, bare] of keyed) {
    if (!/^\d+$/.test(bare.number!)) continue;
    const dept = department(bareKey, bare.number!);
    const lettered = keyed.filter(
      ([key, other]) =>
        key !== bareKey &&
        department(key, other.number!) === dept &&
        new RegExp(`^${bare.number}[a-z]$`).test(other.number!) &&
        sameTerm(bare, other),
    );
    if (lettered.length === 1) groups.join(bareKey, lettered[0]![0]);
  }

  // Courses with no code go with the one course they share assignments with.
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
    if (best && best[1] >= LINKING_MATCHES && (!runnerUp || best[1] > runnerUp[1])) groups.join(identity.key, best[0]);
  }

  for (const [from, to] of Object.entries(merges)) {
    if (!labels.has(to)) continue;
    groups.join(from, to, { force: true });
  }

  // One name per class, picked the same way every time so the class keeps
  // its color and calendar: the one the student merged into, then a real
  // code over a fallback, then the lettered number over the bare one (CS
  // 169A over CS 169), then alphabetical.
  const targets = new Set(Object.values(merges));
  const present = new Set([...identities.values()].map((i) => i.key));
  const members = new Map<string, string[]>();
  for (const key of present) {
    const root = groups.find(key);
    members.set(root, [...(members.get(root) ?? []), key]);
  }
  const named = new Map<string, LinkedCourse>();
  for (const keys of members.values()) {
    const bare = (key: string) => keys.some((k) => k.length === key.length + 1 && k.startsWith(key) && /\d[a-z]$/.test(k));
    const [chosen] = [...keys].sort(
      (a, b) =>
        Number(targets.has(b)) - Number(targets.has(a)) ||
        Number(a.includes(":")) - Number(b.includes(":")) ||
        Number(bare(a)) - Number(bare(b)) ||
        a.localeCompare(b),
    );
    const alsoKnownAs = keys.filter((k) => k !== chosen).sort().map((k) => ({ key: k, label: labels.get(k)! }));
    const linked = { key: chosen!, label: labels.get(chosen!)!, alsoKnownAs };
    for (const key of keys) named.set(key, linked);
  }

  const linked = new Map<string, LinkedCourse>();
  for (const [course, identity] of identities) linked.set(course, named.get(identity.key)!);
  return linked;
}

export interface MergeOptions {
  priority?: Platform[];
  courseAliases?: Record<string, string>;
  /** Courses the student said are the same class, by course key: {"me106a": "eecs106a"}. */
  courseMerges?: Record<string, string>;
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
  const courses = courseIdentities(unique, options.courseAliases ?? {}, options.courseMerges ?? {});
  // Highest-priority platforms first, so they seed each group.
  const sorted = [...unique].sort(
    (a, b) => rank(a.platform) - rank(b.platform) || a.platform.localeCompare(b.platform) || a.id.localeCompare(b.id),
  );

  const groups: { course: LinkedCourse; courseKey: string; courseLabel: string; items: Assignment[] }[] = [];
  for (const assignment of sorted) {
    const course = courses.get(platformCourse(assignment))!;
    const group = groups.find(
      (g) =>
        g.courseKey === course.key &&
        !g.items.some((i) => platformCourse(i) === platformCourse(assignment)) &&
        sameWork(g.items[0]!, assignment),
    );
    if (group) group.items.push(assignment);
    else groups.push({ course, courseKey: course.key, courseLabel: course.label, items: [assignment] });
  }

  return groups.map(({ course, courseKey, courseLabel, items }) => {
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
      ...(course.alsoKnownAs.length ? { alsoKnownAs: course.alsoKnownAs } : {}),
    };
  });
}
