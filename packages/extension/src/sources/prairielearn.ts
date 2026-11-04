import { kindFromTitle, type Assignment, type AssignmentKind, type Course } from "@backpack/core";
import { parse, type HTMLElement } from "node-html-parser";

/**
 * PrairieLearn has no student API, so Backpack reads the pages a student
 * sees, with the browser's PrairieLearn login. The markup follows
 * PrairieLearn's own templates (pages/home and pages/studentAssessments in
 * github.com/PrairieLearn/PrairieLearn).
 */

export class PrairieLearnError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface PrairieLearnCourse {
  /** The course instance id, e.g. "12345" in /pl/course_instance/12345. */
  id: string;
  /** "CS 61C". */
  shortName: string;
  /** The whole line the home page shows, e.g. "CS 61C: Great Ideas, Fall 2026". */
  name: string;
}

const text = (el: HTMLElement | null | undefined) => (el?.text ?? "").replace(/\s+/g, " ").trim();

/**
 * The courses on the home page (/pl) the student is enrolled in. Courses
 * with instructor access link to /instructor pages or /course/, and pending
 * invitations have no link, so neither is picked up.
 */
export function parseHomePage(html: string): PrairieLearnCourse[] {
  const courses = new Map<string, PrairieLearnCourse>();
  for (const link of parse(html).querySelectorAll("a[href]")) {
    const id = /\/pl\/course_instance\/(\d+)\/?$/.exec(link.getAttribute("href") ?? "")?.[1];
    if (!id || courses.has(id)) continue;
    const name = text(link);
    courses.set(id, { id, shortName: name.split(":")[0]!.trim(), name });
  }
  return [...courses.values()];
}

/** Short time zone names PrairieLearn prints, as UTC offsets. */
const ZONE_OFFSETS: Record<string, string> = {
  UTC: "+00:00",
  GMT: "+00:00",
  EST: "-05:00",
  EDT: "-04:00",
  CST: "-06:00",
  CDT: "-05:00",
  MST: "-07:00",
  MDT: "-06:00",
  PST: "-08:00",
  PDT: "-07:00",
  AKST: "-09:00",
  AKDT: "-08:00",
  HST: "-10:00",
};

/** "2026-11-07 23:59:00 (PST)" (PrairieLearn's formatDate) -> ISO 8601, or null. */
export function parsePrairieLearnDate(value: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? \(([^)]+)\)$/.exec(value.trim());
  if (!m) return null;
  const zone = m[3]!;
  let offset = ZONE_OFFSETS[zone];
  // Zones without a common abbreviation print as "GMT+5:30" or "GMT-3".
  const gmt = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone);
  if (!offset && gmt) offset = `${gmt[1]}${gmt[2]!.padStart(2, "0")}:${gmt[3] ?? "00"}`;
  if (!offset) return null;
  const instant = Date.parse(`${m[1]}T${m[2]}${offset}`);
  return Number.isNaN(instant) ? null : new Date(instant).toISOString();
}

/**
 * The full-credit deadline from an assessment's "Credit schedule" popover:
 * the latest end of a row worth 100% or more, else of any row worth credit.
 */
export function dueFromSchedule(popoverHtml: string): string | null {
  const rows = parse(popoverHtml)
    .querySelectorAll("tbody tr")
    .map((row) => row.querySelectorAll("td").map((td) => text(td)))
    .map(([credit = "", , end = ""]) => ({ credit: Number.parseFloat(credit), end: parsePrairieLearnDate(end) }))
    .filter((row): row is { credit: number; end: string } => row.end !== null && row.credit > 0);
  const latest = (list: typeof rows) =>
    list.reduce<string | null>((best, row) => (best === null || row.end > best ? row.end : best), null);
  return latest(rows.filter((row) => row.credit >= 100)) ?? latest(rows);
}

/** "HW3" or "E1" (set abbreviation + number) -> a kind, when the set says. */
function kindOf(label: string, title: string): AssignmentKind {
  if (/^(e|exam|mt|midterm|final)\d/i.test(label)) return "exam";
  if (/^(q|quiz)\d/i.test(label)) return "quiz";
  if (/^lab\d/i.test(label)) return "lab";
  if (/^(proj|project)\d/i.test(label)) return "project";
  if (/^(hw|homework)\d/i.test(label)) return "assignment";
  return kindFromTitle(title);
}

/** The assessments table on /pl/course_instance/:id/assessments. */
export function parseAssessmentsPage(html: string, course: PrairieLearnCourse, host: string): Assignment[] {
  const base = `https://${host}`;
  const platformCourse: Course = {
    platform: "prairielearn",
    id: course.id,
    name: course.name || course.shortName,
    ...(course.shortName ? { code: course.shortName } : {}),
  };

  const assignments: Assignment[] = [];
  for (const row of parse(html).querySelectorAll('table[aria-label="Assessments"] tr')) {
    // Group headings ("Homework", "Exams") have no badge.
    const label = text(row.querySelector('[data-testid="assessment-set-badge"]'));
    // "E1#2" is one attempt of a multi-attempt assessment, already listed as "E1".
    if (!label || label.includes("#")) continue;

    const cells = row.querySelectorAll("td");
    const titleCell = cells[1];
    if (!titleCell) continue;
    const link = titleCell.querySelector("a");
    const name = text(link ?? titleCell.querySelector("span") ?? titleCell)
      .replace(/\s*Credit schedule$/, "")
      .trim();
    if (!name) continue;
    // Titles like "Floating Point" lose the number students know them by.
    const title = /\d/.test(name) ? name : `${label}: ${name}`;

    const schedule = titleCell.querySelector('button[data-bs-content]')?.getAttribute("data-bs-content") ?? "";
    const score = /(\d+)%/.exec(text(cells[3]?.querySelector('[data-testid="scorebar"]')));
    const href = link?.getAttribute("href");

    assignments.push({
      platform: "prairielearn",
      // The label stays the same once the student starts the assessment; the link doesn't.
      id: `${course.id}:${label}`,
      course: platformCourse,
      title,
      url: href ? new URL(href, base).href : `${base}/pl/course_instance/${course.id}/assessments`,
      dueAt: schedule ? dueFromSchedule(schedule) : null,
      // PrairieLearn has no "turned in": full marks is the closest thing to done.
      submitted: score ? Number(score[1]) >= 100 : false,
      kind: kindOf(label, title),
      points: null,
    });
  }
  return assignments;
}

/** Reads every assessment in the student's PrairieLearn courses. */
export async function fetchPrairieLearn(host: string, fetchImpl: typeof fetch = fetch): Promise<Assignment[]> {
  const base = `https://${host}`;
  async function page(path: string): Promise<string> {
    const response = await fetchImpl(`${base}${path}`, { credentials: "include", headers: { Accept: "text/html" } });
    const signIn = (why: string) => new PrairieLearnError(`Sign in to ${host} in this browser, then sync again (${why}).`);
    if (response.status === 401 || response.status === 403) throw signIn(`${response.status} on ${path}`);
    if (!response.ok) throw new PrairieLearnError(`PrairieLearn answered ${response.status} for ${path}.`, response.status);
    if (response.url && /\/pl\/(login|auth)/.test(new URL(response.url).pathname)) {
      throw signIn(`sent to ${new URL(response.url).pathname}`);
    }
    return response.text();
  }

  const courses = parseHomePage(await page("/pl"));
  const perCourse = await Promise.all(
    courses.map(async (course) =>
      parseAssessmentsPage(await page(`/pl/course_instance/${course.id}/assessments`), course, host),
    ),
  );
  return perCourse.flat();
}
