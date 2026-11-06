import { isEarlierTerm, kindFromTitle, parseTerm, type Assignment, type Course } from "@backpack/core";
import { parse, type HTMLElement } from "node-html-parser";

/**
 * Flextensions (flextensions.berkeley.edu) is where Berkeley students ask
 * for more time. It has no student API, so Backpack reads the pages a
 * student sees, with the browser's Flextensions login. The markup follows
 * its own templates (courses/index and courses/student_show in
 * github.com/berkeley-cdss/flextensions).
 *
 * Nothing is turned in on Flextensions. What it adds is the extended
 * deadline, and a link to the bCourses assignment each row is for, so its
 * copies join the right bCourses copies exactly.
 */

export const FLEXTENSIONS_HOST = "flextensions.berkeley.edu";
const BASE = `https://${FLEXTENSIONS_HOST}`;

/** Flextensions shows every time in Berkeley's time zone. */
const TIME_ZONE = "America/Los_Angeles";

export class FlextensionsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface FlextensionsCourse {
  /** Flextensions' own id, e.g. "42" in /courses/42. */
  id: string;
  /** "COMPSCI 169A - LEC 001": the bCourses name. */
  name: string;
  /** "COMPSCI 169A". */
  code: string;
  /** "Fall 2026", when it says. */
  term: string;
}

const text = (el: HTMLElement | null | undefined) => (el?.text ?? "").replace(/\s+/g, " ").trim();

/**
 * The classes in the "Student Courses" table on /courses, skipping earlier
 * semesters. Classes you're on staff for are in a different table, so they
 * aren't picked up.
 */
export function parseCourseList(html: string, now = Date.now()): FlextensionsCourse[] {
  const courses: FlextensionsCourse[] = [];
  let term = "";
  for (const row of parse(html).querySelectorAll("#student-assignments-table tbody tr")) {
    const cells = row.querySelectorAll("td");
    // A row spanning the table names the semester of the rows under it.
    if (cells.length === 1) {
      term = text(cells[0]);
      continue;
    }
    const link = row.querySelector("a[href]");
    const id = /\/courses\/(\d+)\/?$/.exec(link?.getAttribute("href") ?? "")?.[1];
    if (!id) continue;
    if (isEarlierTerm(parseTerm(term), now)) continue;
    courses.push({ id, name: text(link), code: text(cells[1]), term: /unknown/i.test(term) ? "" : term });
  }
  return courses;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** How far a time zone is ahead of UTC at an instant, in milliseconds. */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - Math.floor(instant / 60_000) * 60_000;
}

/** The instant a wall-clock time in a time zone happens. */
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  // Twice, so a guess on the far side of a daylight-saving change corrects itself.
  const first = wall - zoneOffset(wall, timeZone);
  return wall - zoneOffset(first, timeZone);
}

/**
 * "Fri, Nov 20 at 11:59pm" -> ISO 8601. Flextensions leaves out the year,
 * so it's the year that falls on the weekday shown, nearest to now.
 */
export function parseFlextensionsTime(value: string, now = Date.now()): string | null {
  const m = /^(\w{3})\w*,?\s+(\w{3})\w*\s+(\d{1,2})\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(value.trim());
  if (!m) return null;
  const weekday = WEEKDAYS.indexOf(m[1]!.toLowerCase());
  const month = MONTHS.indexOf(m[2]!.toLowerCase());
  if (month === -1) return null;
  const hour = (Number(m[4]) % 12) + (m[6]!.toLowerCase() === "pm" ? 12 : 0);
  const thisYear = new Date(now).getUTCFullYear();
  const years = [thisYear - 1, thisYear, thisYear + 1].map((year) =>
    zonedInstant(year, month, Number(m[3]), hour, Number(m[5]), TIME_ZONE),
  );
  const onWeekday = years.filter((t) => weekdayIn(t) === weekday);
  const [nearest] = (onWeekday.length ? onWeekday : years).sort((a, b) => Math.abs(a - now) - Math.abs(b - now));
  return new Date(nearest!).toISOString();
}

/** The day of the week an instant falls on in Berkeley. */
function weekdayIn(instant: number): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "short" }).format(instant);
  return WEEKDAYS.indexOf(name.toLowerCase());
}

/**
 * The assignments table on a class page (/courses/:id): each row's name, a
 * link to the bCourses assignment, the original and extended due dates, and
 * whether an extension request is waiting ("Edit") or answered ("View").
 */
export function parseCoursePage(html: string, course: FlextensionsCourse, now = Date.now()): Assignment[] {
  const rows = parse(html).querySelectorAll("#assignments-table tbody tr");
  // The rows link to bCourses: /courses/<bCourses course>/assignments/<bCourses assignment>.
  const canvasLink = (row: HTMLElement) =>
    /\/courses\/(\d+)\/assignments\/(\d+)/.exec(row.querySelector("td a[href]")?.getAttribute("href") ?? "");
  const canvasCourse = rows.map(canvasLink).find(Boolean)?.[1];
  const platformCourse: Course = {
    platform: "flextensions",
    id: course.id,
    name: course.name || course.code,
    ...(course.code ? { code: course.code } : {}),
    ...(course.term ? { term: course.term } : {}),
    ...(canvasCourse ? { sameAs: `canvas:${canvasCourse}` } : {}),
  };

  const assignments: Assignment[] = [];
  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    const title = text(cells[0]?.querySelector("span")) || text(cells[0]).replace(/\s*View$/, "");
    if (!title || cells.length < 4) continue;
    const id = row.querySelector("input.assignment-id")?.getAttribute("value") ?? `${course.id}:${title.toLowerCase()}`;
    const link = canvasLink(row);
    const href = cells[0]?.querySelector("a[href]")?.getAttribute("href") ?? "";
    const original = parseFlextensionsTime(text(cells[1]), now);
    const extended = parseFlextensionsTime(text(cells[2]), now);
    const request = text(cells[3]);
    const approved = Boolean(extended && original && extended !== original);
    const extension: Assignment["extension"] = approved
      ? { status: "approved", originalDueAt: original }
      : /^edit$/i.test(request)
        ? { status: "pending", originalDueAt: null }
        : undefined;

    assignments.push({
      platform: "flextensions",
      id,
      course: platformCourse,
      title,
      // The bCourses assignment when the row names it: that's where the work is.
      url: /^https:\/\//.test(href) ? href : `${BASE}/courses/${course.id}`,
      dueAt: approved ? extended : original,
      submitted: false,
      kind: kindFromTitle(title),
      points: null,
      submitAt: "elsewhere",
      ...(link ? { sameAs: `canvas:${link[2]}` } : {}),
      ...(extension ? { extension } : {}),
    });
  }
  return assignments;
}

/** Reads every assignment in the student's Flextensions classes this semester. */
export async function fetchFlextensions(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<Assignment[]> {
  async function page(path: string): Promise<{ html: string; path: string }> {
    const response = await fetchImpl(`${BASE}${path}`, { credentials: "include", headers: { Accept: "text/html" } });
    const signIn = (why: string) =>
      new FlextensionsError(`Sign in to ${FLEXTENSIONS_HOST} in this browser, then sync again (${why}).`);
    if (response.status === 401 || response.status === 403) throw signIn(`${response.status} on ${path}`);
    if (!response.ok) throw new FlextensionsError(`Flextensions answered ${response.status} for ${path}.`, response.status);
    return { html: await response.text(), path: response.url ? new URL(response.url).pathname : path };
  }

  const list = await page("/courses");
  // Signed out, Flextensions sends you to its front page to log in.
  if (list.path !== "/courses") throw new FlextensionsError(`Sign in to ${FLEXTENSIONS_HOST} in this browser, then sync again (sent to ${list.path}).`);
  const courses = parseCourseList(list.html, now);
  const perCourse = await Promise.all(
    courses.map(async (course) => {
      // A class that turned extensions off sends you back to /courses.
      const { html, path } = await page(`/courses/${course.id}`);
      return path === `/courses/${course.id}` ? parseCoursePage(html, course, now) : [];
    }),
  );
  return perCourse.flat();
}
