import { describe, expect, it } from "vitest";
import { fetchCanvas, nextLink, parseCanvasJson } from "../src/sources/canvas.js";

const HOST = "bcourses.berkeley.edu";

/** A fake Canvas: maps request paths to JSON pages, with optional Link headers. */
function fakeCanvas(routes: Record<string, { body: unknown; next?: string; status?: number }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const path = url.replace(`https://${HOST}`, "");
    const route = routes[path];
    if (!route) return new Response("not found", { status: 404 });
    const headers = route.next ? { Link: `<https://${HOST}${route.next}>; rel="next", <x>; rel="last"` } : undefined;
    return new Response(`while(1);${JSON.stringify(route.body)}`, { status: route.status ?? 200, headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const COURSES = "/api/v1/users/self/courses?enrollment_state=active&per_page=100";
const assignmentsPath = (id: number) => `/api/v1/courses/${id}/assignments?per_page=100&include[]=submission&order_by=due_at`;

describe("Canvas helpers", () => {
  it("strips Canvas's anti-hijacking prefix", () => {
    expect(parseCanvasJson('while(1);[{"id":1}]')).toEqual([{ id: 1 }]);
    expect(parseCanvasJson('[{"id":1}]')).toEqual([{ id: 1 }]);
  });

  it("finds the next page in a Link header", () => {
    expect(nextLink('<https://a/x?page=2>; rel="next", <https://a/x?page=5>; rel="last"')).toBe("https://a/x?page=2");
    expect(nextLink('<https://a/x?page=5>; rel="last"')).toBeNull();
    expect(nextLink(null)).toBeNull();
  });
});

describe("fetchCanvas", () => {
  it("reads assignments from every active course, across pages, with the browser's login", async () => {
    const { fetchImpl, calls } = fakeCanvas({
      [COURSES]: {
        body: [
          { id: 1500, name: "COMPSCI 169A - LEC 001", course_code: "COMPSCI 169A" },
          { id: 1600, access_restricted_by_date: true },
        ],
      },
      [assignmentsPath(1500)]: {
        body: [
          {
            id: 9,
            name: "HW 3: Ruby Intro",
            due_at: "2026-10-24T06:59:00Z",
            html_url: "https://bcourses.berkeley.edu/courses/1500/assignments/9",
            points_possible: 10,
            submission_types: ["online_upload"],
            submission: { workflow_state: "submitted", submitted_at: "2026-10-20T01:00:00Z" },
          },
          {
            id: 10,
            name: "Reading Quiz 4",
            due_at: null,
            html_url: "https://bcourses.berkeley.edu/courses/1500/assignments/10",
            points_possible: 2,
            submission_types: ["online_quiz"],
            submission: { workflow_state: "unsubmitted", submitted_at: null },
          },
        ],
        next: "/page2",
      },
      "/page2": {
        body: [
          {
            id: 11,
            name: "Project 1: Midterm Prep",
            due_at: "2026-11-01T06:59:00Z",
            html_url: "https://bcourses.berkeley.edu/courses/1500/assignments/11",
            points_possible: null,
            submission_types: ["none"],
          },
          {
            id: 12,
            name: "Unpublished draft",
            due_at: null,
            html_url: "x",
            points_possible: 0,
            submission_types: [],
            published: false,
          },
        ],
      },
    });

    const assignments = await fetchCanvas(HOST, fetchImpl);
    expect(assignments.map((a) => [a.id, a.kind, a.submitted])).toEqual([
      ["9", "assignment", true],
      ["10", "quiz", false],
      ["11", "exam", false],
    ]);
    expect(assignments[0]).toMatchObject({
      platform: "canvas",
      course: { platform: "canvas", id: "1500", name: "COMPSCI 169A - LEC 001", code: "COMPSCI 169A" },
      title: "HW 3: Ruby Intro",
      dueAt: "2026-10-24T06:59:00Z",
      points: 10,
    });
    // The closed course (1600) was never asked for, and every call carried the login cookie.
    expect(calls.some((c) => c.url.includes("/courses/1600/"))).toBe(false);
    expect(calls.every((c) => c.init?.credentials === "include")).toBe(true);
  });

  it("asks the student to sign in when Canvas says they're signed out", async () => {
    const { fetchImpl } = fakeCanvas({ [COURSES]: { body: { errors: [] }, status: 401 } });
    await expect(fetchCanvas(HOST, fetchImpl)).rejects.toThrow(`Sign in to ${HOST} in this browser, then sync again.`);
  });
});
