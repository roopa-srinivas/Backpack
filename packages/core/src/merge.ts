import { identifyCourse } from "./courses.js";
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
  [/\bdiscussion\b/g, "disc"],
  [/\bmidterm\b/g, "mt"],
];

/** "Homework 03: Ruby Intro" -> "hw3 ruby intro". */
export function normalizeTitle(title: string): string {
  let s = title.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  for (const [pattern, replacement] of WORD_SWAPS) s = s.replace(pattern, replacement);
  return s
    .replace(/\b(hw|proj|lab|disc|mt|quiz)\s+0*(\d+)/g, "$1$2") // "hw 03" -> "hw3"
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

function dueClose(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_DUE_WINDOW_MS;
}

export interface MergeOptions {
  priority?: Platform[];
  courseAliases?: Record<string, string>;
}

/**
 * Groups copies of the same assignment across platforms into tasks. Copies
 * merge only when they're in the same course, on different platforms, with
 * matching titles and due dates within 36 hours.
 */
export function mergeAssignments(assignments: Assignment[], options: MergeOptions = {}): Task[] {
  const priority = options.priority ?? DEFAULT_PLATFORM_PRIORITY;
  const rank = (p: Platform) => {
    const i = priority.indexOf(p);
    return i === -1 ? priority.length : i;
  };
  // Highest-priority platforms first, so they seed each group.
  const sorted = [...assignments].sort(
    (a, b) => rank(a.platform) - rank(b.platform) || a.platform.localeCompare(b.platform) || a.id.localeCompare(b.id),
  );

  const groups: { courseKey: string; courseLabel: string; items: Assignment[] }[] = [];
  for (const assignment of sorted) {
    const course = identifyCourse(assignment.course, options.courseAliases);
    const group = groups.find(
      (g) =>
        g.courseKey === course.key &&
        !g.items.some((i) => i.platform === assignment.platform) &&
        titlesMatch(g.items[0]!.title, assignment.title) &&
        dueClose(g.items[0]!.dueAt, assignment.dueAt),
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
