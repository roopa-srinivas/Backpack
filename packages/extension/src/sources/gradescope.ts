import { kindFromTitle, type Assignment, type Course } from "@backpack/core";
import { parse, type HTMLElement } from "node-html-parser";

/**
 * Gradescope has no student API, so Backpack reads the same pages a student
 * sees, using the browser's Gradescope login. The parsing is kept separate
 * from fetching so it can be tested against saved pages.
 *
 * Service workers have no DOMParser, hence node-html-parser.
 */

export const GRADESCOPE_HOST = "www.gradescope.com";
const BASE = `https://${GRADESCOPE_HOST}`;

export class GradescopeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface GradescopeCourse {
  id: string;
  /** Short name course staff chose, e.g. "CS 169A". */
  shortName: string;
  /** Full name, e.g. "Software Engineering". */
  name: string;
  term: string;
}

const text = (el: HTMLElement | null | undefined) => (el?.text ?? "").replace(/\s+/g, " ").trim();

/** True when Gradescope answered with its sign-in page instead of the one asked for. */
export function isLoginPage(html: string): boolean {
  return /name="session\[email\]"/.test(html);
}

/**
 * The student courses on the account page (gradescope.com/account), for the
 * most recent term only. Courses you teach or TA are skipped: their
 * assignments aren't yours to turn in.
 */
export function parseCourseList(html: string): GradescopeCourse[] {
  const root = parse(html);
  let heading = "";
  let lists: { heading: string; list: HTMLElement }[] = [];

  // Headings ("Instructor Courses", "Student Courses") come before each list.
  for (const el of root.querySelectorAll(".pageHeading, .courseList")) {
    if (el.classList.contains("pageHeading")) heading = text(el);
    else lists.push({ heading, list: el });
  }
  lists = lists.filter((l) => !/instructor/i.test(l.heading));

  const courses: GradescopeCourse[] = [];
  for (const { list } of lists) {
    // Terms are listed newest first; only the newest is current.
    const term = text(list.querySelector(".courseList--term"));
    const current = list.querySelector(".courseList--coursesForTerm");
    for (const box of current?.querySelectorAll("a.courseBox") ?? []) {
      const id = /\/courses\/(\d+)/.exec(box.getAttribute("href") ?? "")?.[1];
      if (!id) continue;
      courses.push({
        id,
        shortName: text(box.querySelector(".courseBox--shortname")),
        name: text(box.querySelector(".courseBox--name")),
        term,
      });
    }
  }
  return courses;
}

/** "2026-10-23 23:59:00 -0700" (Gradescope's datetime attribute) -> ISO 8601. */
export function parseGradescopeTime(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-])(\d{2}):?(\d{2})$/.exec(value.trim());
  if (m) {
    const time = m[2]!.length === 5 ? `${m[2]}:00` : m[2];
    return new Date(`${m[1]}T${time}${m[3]}${m[4]}:${m[5]}`).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** The assignments table on a course page (gradescope.com/courses/:id). */
export function parseCoursePage(html: string, course: GradescopeCourse): Assignment[] {
  const root = parse(html);
  const platformCourse: Course = {
    platform: "gradescope",
    id: course.id,
    name: course.name || course.shortName,
    ...(course.shortName ? { code: course.shortName } : {}),
    ...(course.term ? { term: course.term } : {}),
  };

  const assignments: Assignment[] = [];
  for (const row of root.querySelectorAll("#assignments-student-table tbody tr")) {
    const cell = row.querySelector("th") ?? row.querySelector("td");
    const title = text(cell);
    if (!title) continue;

    // Submitted work links to the submission; open work has a submit button;
    // some assignments are only text.
    const link = cell?.querySelector("a");
    const button = cell?.querySelector("button");
    const href = link?.getAttribute("href") ?? "";
    const id =
      /\/assignments\/(\d+)/.exec(href)?.[1] ??
      button?.getAttribute("data-assignment-id") ??
      `${course.id}:${title.toLowerCase()}`;
    const url = href
      ? new URL(href, BASE).href
      : /^\d+$/.test(id)
        ? `${BASE}/courses/${course.id}/assignments/${id}`
        : `${BASE}/courses/${course.id}`;

    const status = row.querySelector(".submissionStatus");
    const statusText = text(status);
    const score = /([\d.]+)\s*\/\s*([\d.]+)/.exec(text(row.querySelector(".submissionStatus--score")) || statusText);
    const submitted = Boolean(score) || (Boolean(statusText) && !/no submission/i.test(statusText));

    assignments.push({
      platform: "gradescope",
      id,
      course: platformCourse,
      title,
      url,
      dueAt: parseGradescopeTime(row.querySelector("time.submissionTimeChart--dueDate")?.getAttribute("datetime")),
      submitted,
      kind: kindFromTitle(title),
      points: score ? Number(score[2]) : null,
    });
  }
  return assignments;
}

/** Reads every assignment in the student's current Gradescope courses. */
export async function fetchGradescope(fetchImpl: typeof fetch = fetch): Promise<Assignment[]> {
  async function page(path: string): Promise<string> {
    const response = await fetchImpl(`${BASE}${path}`, { credentials: "include", headers: { Accept: "text/html" } });
    // Each way of being turned away says which it was, to tell a signed-out
    // browser from cookies not reaching Gradescope.
    const signIn = (why: string, status?: number) =>
      new GradescopeError(`Sign in to gradescope.com in this browser, then sync again (${why}).`, status);
    if (response.status === 401 || response.status === 403) throw signIn(`${response.status} on ${path}`, response.status);
    if (!response.ok) throw new GradescopeError(`Gradescope answered ${response.status} for ${path}.`, response.status);
    const html = await response.text();
    if (/\/login/.test(new URL(response.url || BASE).pathname)) throw signIn(`sent to ${new URL(response.url).pathname}`);
    if (isLoginPage(html)) throw signIn(`sign-in form on ${path}`);
    return html;
  }

  const courses = parseCourseList(await page("/account"));
  const perCourse = await Promise.all(
    courses.map(async (course) => parseCoursePage(await page(`/courses/${course.id}`), course)),
  );
  return perCourse.flat();
}
