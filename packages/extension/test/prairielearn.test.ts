import { describe, expect, it } from "vitest";
import {
  dueFromSchedule,
  fetchPrairieLearn,
  parseAssessmentsPage,
  parseHomePage,
  parsePrairieLearnDate,
  type PrairieLearnCourse,
} from "../src/sources/prairielearn.js";

const HOST = "us.prairielearn.com";

// Built from PrairieLearn's templates: pages/home/components/StudentCoursesCard.tsx
// and pages/studentAssessments/studentAssessments.html.tsx.
const HOME = `
<div class="card mb-4"><div class="card-header"><h2>Courses with instructor access</h2></div>
  <table aria-label="Courses with instructor access"><tbody><tr><td>
    <a href="/pl/course/9">CS 10: Beauty and Joy</a>
    <a href="/pl/course_instance/900/instructor">Fall 2026</a>
  </td></tr></tbody></table>
</div>
<div class="card mb-4"><div class="card-header"><h2>Courses with student access</h2></div>
  <table class="table" aria-label="Courses with student access"><tbody>
    <tr class="table-warning"><td><span class="fw-semibold">EECS 16A: Designing Information Devices, Fall 2026</span>
      <span class="badge">Invitation</span></td></tr>
    <tr><td><div><a href="/pl/course_instance/4021">CS 61C: Great Ideas in Computer Architecture, Fall 2026</a>
      <button type="button" class="btn btn-danger btn-sm">Remove</button></div></td></tr>
    <tr><td><div><a href="/pl/course_instance/4100">DATA 100: Principles and Techniques of Data Science, Fall 2026</a></div></td></tr>
  </tbody></table>
</div>`;

/** The "Credit schedule" popover button, with its table escaped into an attribute as PrairieLearn does. */
function schedule(rows: [credit: string, start: string, end: string][]): string {
  const table = `<div class="table-responsive"><table class="table table-sm mb-0" aria-label="Credit schedule">
    <thead><tr><th scope="col">Credit</th><th scope="col">Start</th><th scope="col">End</th></tr></thead>
    <tbody>${rows.map(([c, s, e]) => `<tr><td>${c}</td><td>${s}</td><td>${e}</td></tr>`).join("")}</tbody></table></div>`;
  const escaped = table.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<button type="button" class="btn btn-xs btn-outline-secondary ms-1" data-bs-toggle="popover"
    data-bs-title="Credit schedule" data-bs-content="${escaped}">Credit schedule</button>`;
}

function row(label: string, titleHtml: string, credit: string, score: string): string {
  return `<tr>
    <td class="align-middle" style="width: 1%"><span class="badge color-red1" data-testid="assessment-set-badge">${label}</span></td>
    <td class="align-middle">${titleHtml}</td>
    <td class="text-center align-middle">${credit}</td>
    <td class="text-center align-middle">${score}</td>
  </tr>`;
}

const scorebar = (pct: number) =>
  `<div class="progress border border-success" data-testid="scorebar"><div class="progress-bar bg-success" style="width: ${pct}%">${pct >= 50 ? `${pct}%` : ""}</div><div class="d-flex">${pct >= 50 ? "" : `${pct}%`}</div></div>`;

const ASSESSMENTS = `
<table class="table table-sm table-hover" aria-label="Assessments">
  <thead><tr><th style="width: 1%"><span class="visually-hidden">Label</span></th><th><span class="visually-hidden">Title</span></th>
    <th class="text-center">Available credit</th><th class="text-center">Score</th></tr></thead>
  <tbody>
    <tr><th colspan="4" scope="rowgroup" data-testid="assessment-group-heading">Homework</th></tr>
    ${row(
      "HW3",
      `<a href="/pl/course_instance/4021/assessment/77001/">Floating Point</a>
       ${schedule([
         ["100%", "2026-10-28 00:00:01 (PDT)", "2026-11-06 23:59:59 (PST)"],
         ["80%", "2026-11-06 23:59:59 (PST)", "2026-11-09 23:59:59 (PST)"],
       ])}`,
      "100% until 23:59, Fri, Nov 6",
      "Not started",
    )}
    ${row(
      "HW2",
      `<a href="/pl/course_instance/4021/assessment_instance/880211/">Homework 2: Pointers</a>
       ${schedule([["100%", "2026-10-14 00:00:01 (PDT)", "2026-10-23 23:59:59 (PDT)"]])}`,
      "100% until 23:59, Fri, Oct 23",
      scorebar(100),
    )}
    ${row("HW4", `<span class="text-muted">Caches</span>`, "", "Not started")}
  </tbody>
  <tbody>
    <tr><th colspan="4" scope="rowgroup">Exams</th></tr>
    ${row("E1", `Practice Midterm`, "", `<a class="btn btn-primary btn-sm">New instance</a>`)}
    ${row(
      "E1#1",
      `<a href="/pl/course_instance/4021/assessment_instance/9001/">Practice Midterm instance #1</a>`,
      "",
      scorebar(40),
    )}
    ${row(
      "Q5",
      `<a href="/pl/course_instance/4021/assessment/77050/">RISC-V Quiz</a>
       ${schedule([["120%", "2026-11-01 00:00:00 (PDT)", "2026-11-03 23:59:00 (PST)"], ["100%", "2026-11-03 23:59:00 (PST)", "2026-11-05 23:59:00 (PST)"]])}`,
      "120% until 23:59, Tue, Nov 3",
      scorebar(35),
    )}
  </tbody>
</table>`;

const CS61C: PrairieLearnCourse = {
  id: "4021",
  shortName: "CS 61C",
  name: "CS 61C: Great Ideas in Computer Architecture, Fall 2026",
};

describe("PrairieLearn parsing", () => {
  it("lists enrolled student courses, not instructor courses or invitations", () => {
    expect(parseHomePage(HOME)).toEqual([
      CS61C,
      { id: "4100", shortName: "DATA 100", name: "DATA 100: Principles and Techniques of Data Science, Fall 2026" },
    ]);
  });

  it("reads PrairieLearn's dates in any zone", () => {
    expect(parsePrairieLearnDate("2026-11-06 23:59:59 (PST)")).toBe("2026-11-07T07:59:59.000Z");
    expect(parsePrairieLearnDate("2026-10-23 23:59:59 (PDT)")).toBe("2026-10-24T06:59:59.000Z");
    expect(parsePrairieLearnDate("2026-11-06 12:00:00 (GMT+5:30)")).toBe("2026-11-06T06:30:00.000Z");
    expect(parsePrairieLearnDate("2026-11-06 12:00:00 (UTC)")).toBe("2026-11-06T12:00:00.000Z");
    expect(parsePrairieLearnDate("—")).toBeNull();
  });

  it("takes the full-credit deadline, not the late one", () => {
    const html = `<table><tbody>
      <tr><td>100%</td><td>—</td><td>2026-11-06 23:59:59 (PST)</td></tr>
      <tr><td>50%</td><td>—</td><td>2026-11-13 23:59:59 (PST)</td></tr>
      <tr><td>None</td><td>—</td><td>2026-12-01 00:00:00 (PST)</td></tr></tbody></table>`;
    expect(dueFromSchedule(html)).toBe("2026-11-07T07:59:59.000Z");
    // Bonus credit early on still counts; the 100% row ends last.
    expect(dueFromSchedule(html.replace("50%", "120%"))).toBe("2026-11-14T07:59:59.000Z");
    expect(dueFromSchedule("<table><tbody><tr><td>None</td><td>—</td><td>—</td></tr></tbody></table>")).toBeNull();
  });

  it("reads each assessment's title, deadline, link and completion", () => {
    const [hw3, hw2, hw4, e1, q5, ...rest] = parseAssessmentsPage(ASSESSMENTS, CS61C, HOST);
    expect(rest).toEqual([]);
    expect(hw3).toEqual({
      platform: "prairielearn",
      id: "4021:HW3",
      course: { platform: "prairielearn", id: "4021", name: CS61C.name, code: "CS 61C" },
      title: "HW3: Floating Point",
      url: "https://us.prairielearn.com/pl/course_instance/4021/assessment/77001/",
      dueAt: "2026-11-07T07:59:59.000Z",
      submitted: false,
      kind: "assignment",
      points: null,
    });
    expect(hw2).toMatchObject({ id: "4021:HW2", title: "Homework 2: Pointers", dueAt: "2026-10-24T06:59:59.000Z", submitted: true });
    expect(hw4).toMatchObject({ title: "HW4: Caches", dueAt: null, url: "https://us.prairielearn.com/pl/course_instance/4021/assessments" });
    expect(e1).toMatchObject({ id: "4021:E1", title: "E1: Practice Midterm", kind: "exam", dueAt: null });
    expect(q5).toMatchObject({ kind: "quiz", dueAt: "2026-11-06T07:59:00.000Z", submitted: false });
  });
});

describe("fetchPrairieLearn", () => {
  it("reads every enrolled course with the browser's login", async () => {
    const calls: RequestInit[] = [];
    const pages: Record<string, string> = {
      "/pl": HOME,
      "/pl/course_instance/4021/assessments": ASSESSMENTS,
      "/pl/course_instance/4100/assessments": `<table aria-label="Assessments"><tbody></tbody></table>`,
    };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(init);
      const body = pages[url.replace(`https://${HOST}`, "")];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
    }) as unknown as typeof fetch;

    const assignments = await fetchPrairieLearn(HOST, fetchImpl);
    expect(assignments.map((a) => a.id)).toEqual(["4021:HW3", "4021:HW2", "4021:HW4", "4021:E1", "4021:Q5"]);
    expect(calls.every((init) => init.credentials === "include")).toBe(true);
  });

  it("asks the student to sign in when sent to the login page", async () => {
    const fetchImpl = (async () => {
      const response = new Response("<form>Sign in</form>");
      Object.defineProperty(response, "url", { value: `https://${HOST}/pl/login?redirect=/pl` });
      return response;
    }) as unknown as typeof fetch;
    await expect(fetchPrairieLearn(HOST, fetchImpl)).rejects.toThrow(`Sign in to ${HOST}`);
  });
});
