import { kindFromTitle, type Assignment, type AssignmentKind, type Course } from "@backpack/core";

/** The parts of Canvas's REST API responses Backpack reads. */
export interface CanvasCourse {
  id: number;
  name?: string;
  course_code?: string;
  /** Set (with no name) on courses that haven't opened or have closed. */
  access_restricted_by_date?: boolean;
  /** Included with include[]=term; "Default Term" for sites outside any semester. */
  term?: { name?: string };
}

interface CanvasAssignment {
  id: number;
  name: string;
  due_at: string | null;
  html_url: string;
  points_possible: number | null;
  submission_types: string[];
  published?: boolean;
  submission?: { workflow_state: string; submitted_at: string | null };
}

export class CanvasError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The next page's URL from a Link header, if there is one. */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * Canvas prefixes JSON with `while(1);` when a request is authorized by the
 * browser session (it blocks JSON hijacking), so strip it before parsing.
 */
export function parseCanvasJson(text: string): unknown {
  return JSON.parse(text.replace(/^while\(1\);/, ""));
}

function kindOf(assignment: CanvasAssignment): AssignmentKind {
  const types = assignment.submission_types;
  if (types.includes("online_quiz")) return "quiz";
  if (types.includes("discussion_topic")) return "discussion";
  return kindFromTitle(assignment.name);
}

const SUBMITTED_STATES = new Set(["submitted", "graded", "pending_review"]);

/** Submission types that hand the work in on bCourses itself. */
const SUBMIT_HERE = new Set([
  "online_upload",
  "online_text_entry",
  "online_url",
  "online_quiz",
  "discussion_topic",
  "media_recording",
  "student_annotation",
]);

/**
 * Where the work is turned in: on bCourses, through a tool bCourses opens
 * (Gradescope, PrairieLearn), or somewhere else entirely ("none", "on_paper"
 * and "not_graded" are placeholders for a grade).
 */
function submitAtOf(assignment: CanvasAssignment): Assignment["submitAt"] {
  const types = assignment.submission_types;
  if (types.some((t) => SUBMIT_HERE.has(t))) return "here";
  if (types.includes("external_tool")) return "tool";
  return "elsewhere";
}

export function toAssignment(course: CanvasCourse, item: CanvasAssignment): Assignment {
  return {
    platform: "canvas",
    id: String(item.id),
    course: toCourse(course),
    title: item.name,
    url: item.html_url,
    dueAt: item.due_at,
    submitted: Boolean(item.submission?.submitted_at) || SUBMITTED_STATES.has(item.submission?.workflow_state ?? ""),
    kind: kindOf(item),
    points: item.points_possible,
    submitAt: submitAtOf(item),
  };
}

export interface CanvasApi {
  host: string;
  /** Every item of a paginated list. */
  getAll<T>(path: string): Promise<T[]>;
  /** One JSON object. */
  get<T>(path: string): Promise<T>;
  /** A regular Canvas page, as HTML. */
  getPage(path: string): Promise<string>;
}

/**
 * GETs against a school's Canvas using the browser's Canvas login. `host` is
 * the school's Canvas, e.g. "bcourses.berkeley.edu".
 */
export function canvasApi(host: string, fetchImpl: typeof fetch = fetch): CanvasApi {
  const base = `https://${host}`;

  async function request(url: string, path: string, accept: string): Promise<Response> {
    const response = await fetchImpl(url, { credentials: "include", headers: { Accept: accept } });
    if (response.status === 401 || response.status === 403) {
      throw new CanvasError(`Sign in to ${host} in this browser, then sync again.`, response.status);
    }
    if (!response.ok) throw new CanvasError(`Canvas answered ${response.status} for ${path}.`, response.status);
    return response;
  }

  return {
    host,
    async getAll<T>(path: string): Promise<T[]> {
      const items: T[] = [];
      let url: string | null = `${base}${path}`;
      while (url) {
        const response: Response = await request(url, path, "application/json");
        items.push(...(parseCanvasJson(await response.text()) as T[]));
        url = nextLink(response.headers.get("Link"));
      }
      return items;
    },
    async get<T>(path: string): Promise<T> {
      const response = await request(`${base}${path}`, path, "application/json");
      return parseCanvasJson(await response.text()) as T;
    },
    async getPage(path: string): Promise<string> {
      return (await request(`${base}${path}`, path, "text/html")).text();
    },
  };
}

/** The student's active courses, skipping ones that haven't opened or have closed. */
export async function fetchCanvasCourses(api: CanvasApi): Promise<CanvasCourse[]> {
  const courses = await api.getAll<CanvasCourse>("/api/v1/users/self/courses?enrollment_state=active&include[]=term&per_page=100");
  return courses.filter((c) => !c.access_restricted_by_date);
}

/** How Canvas courses look to the rest of Backpack. */
export function toCourse(course: CanvasCourse): Course {
  const term = course.term?.name;
  return {
    platform: "canvas",
    id: String(course.id),
    name: course.name ?? course.course_code ?? `Course ${course.id}`,
    ...(course.course_code ? { code: course.course_code } : {}),
    ...(term && !/default term/i.test(term) ? { term } : {}),
  };
}

/**
 * Reads every assignment in the student's active Canvas courses, using the
 * browser's Canvas login.
 */
export async function fetchCanvas(host: string, fetchImpl: typeof fetch = fetch): Promise<Assignment[]> {
  const api = canvasApi(host, fetchImpl);
  const courses = await fetchCanvasCourses(api);
  const perCourse = await Promise.all(
    courses.map(async (course) => {
      const items = await api.getAll<CanvasAssignment>(
        `/api/v1/courses/${course.id}/assignments?per_page=100&include[]=submission&order_by=due_at`,
      );
      return items.filter((item) => item.published !== false).map((item) => toAssignment(course, item));
    }),
  );
  return perCourse.flat();
}
