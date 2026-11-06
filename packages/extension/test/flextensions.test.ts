import { mergeAssignments } from "@backpack/core";
import { describe, expect, it } from "vitest";
import { toAssignment } from "../src/sources/canvas.js";
import {
  fetchFlextensions,
  parseCourseList,
  parseCoursePage,
  parseFlextensionsTime,
  type FlextensionsCourse,
} from "../src/sources/flextensions.js";

const NOW = Date.parse("2026-11-05T20:00:00Z");

// Trimmed copies of the markup Flextensions serves students (courses/index, courses/student_show).
const COURSES = `
<h2 class="h4">Staff Courses</h2>
<table id="assignments-table"><tbody>
  <tr><td colspan="3">Fall 2026</td></tr>
  <tr><td><a href="/courses/7"> CS 61A TA site </a></td><td>COMPSCI 61A</td><td>TA</td></tr>
</tbody></table>
<h2 class="h4">Student Courses</h2>
<table class="table" id="student-assignments-table">
  <thead><tr><th>Name</th><th>Course</th></tr></thead>
  <tbody>
    <tr class="table-blue-light"><td colspan="2" class="fw-bold">Fall 2026</td></tr>
    <tr><td><a href="/courses/42"> COMPSCI 169A - LEC 001</a></td><td>COMPSCI 169A</td></tr>
    <tr><td><a href="/courses/43"> COMPSCI 160 - LEC 001</a></td><td>COMPSCI 160</td></tr>
    <tr class="table-blue-light"><td colspan="2" class="fw-bold">Spring 2026</td></tr>
    <tr><td><a href="/courses/12"> COMPSCI 61B - LEC 001</a></td><td>COMPSCI 61B</td></tr>
  </tbody>
</table>`;

const row = (id: number, name: string, canvasId: number, original: string, extended: string, button: string) => `
<tr>
  <input type="hidden" class="assignment-id" name="assignment_id" value="${id}">
  <td>
    <div class="d-flex justify-content-between align-items-center">
      <span>${name}</span>
      <a href="https://bcourses.berkeley.edu/courses/1500/assignments/${canvasId}" target="_blank" class="ms-2">
        View <i class="fas fa-up-right-from-square"></i>
      </a>
    </div>
  </td>
  <td class="text-center">${original}</td>
  <td class="text-center">${extended}</td>
  <td class="text-center"><a href="/courses/42/requests/${button === "New" ? "new" : id}" class="btn btn-sm">${button}</a></td>
</tr>`;

const COURSE_PAGE = `
<h4 class="mb-4">COMPSCI 169A - LEC 001 / COMPSCI 169A <span class="badge">Student</span></h4>
<table class="table table-bordered table-striped" id="assignments-table">
  <thead><tr><th>Assignment</th><th>Original Due Date</th><th>Extended Due Date</th><th>Request</th></tr></thead>
  <tbody>
    ${row(901, "HW 3: Ruby Intro", 4521, "Fri, Nov 6 at 11:59pm", "Mon, Nov 9 at 11:59pm", "View")}
    ${row(902, "HW 4: Rails", 4522, "Fri, Nov 13 at 11:59pm", "Fri, Nov 13 at 11:59pm", "Edit")}
    ${row(903, "Project Checkpoint", 4523, "Tue, Nov 17 at 9:00am", "Tue, Nov 17 at 9:00am", "New")}
    ${row(904, "Reading", 4524, "N/A", "N/A", "New")}
  </tbody>
</table>`;

const CS169A: FlextensionsCourse = { id: "42", name: "COMPSCI 169A - LEC 001", code: "COMPSCI 169A", term: "Fall 2026" };

describe("Flextensions", () => {
  it("reads this semester's student classes, not staff ones or earlier semesters", () => {
    expect(parseCourseList(COURSES, NOW)).toEqual([
      CS169A,
      { id: "43", name: "COMPSCI 160 - LEC 001", code: "COMPSCI 160", term: "Fall 2026" },
    ]);
  });

  it("reads Berkeley times with no year, across daylight saving and the new year", () => {
    expect(parseFlextensionsTime("Fri, Nov 6 at 11:59pm", NOW)).toBe("2026-11-07T07:59:00.000Z");
    expect(parseFlextensionsTime("Fri, Oct 30 at 11:59pm", NOW)).toBe("2026-10-31T06:59:00.000Z");
    expect(parseFlextensionsTime("Tue, Nov 17 at 12:00am", NOW)).toBe("2026-11-17T08:00:00.000Z");
    expect(parseFlextensionsTime("Fri, Jan 15 at 5:00pm", NOW)).toBe("2027-01-16T01:00:00.000Z");
    expect(parseFlextensionsTime("Mon, Aug 31 at 12:00pm", NOW)).toBe("2026-08-31T19:00:00.000Z");
    expect(parseFlextensionsTime("N/A", NOW)).toBeNull();
  });

  it("reads each assignment with its extension and the bCourses copy it's for", () => {
    const [hw3, hw4, checkpoint, reading] = parseCoursePage(COURSE_PAGE, CS169A, NOW);
    expect(hw3).toMatchObject({
      platform: "flextensions",
      id: "901",
      title: "HW 3: Ruby Intro",
      url: "https://bcourses.berkeley.edu/courses/1500/assignments/4521",
      dueAt: "2026-11-10T07:59:00.000Z",
      extension: { status: "approved", originalDueAt: "2026-11-07T07:59:00.000Z" },
      sameAs: "canvas:4521",
      submitAt: "elsewhere",
      course: { platform: "flextensions", id: "42", code: "COMPSCI 169A", term: "Fall 2026", sameAs: "canvas:1500" },
    });
    expect(hw4).toMatchObject({ dueAt: "2026-11-14T07:59:00.000Z", extension: { status: "pending", originalDueAt: null } });
    expect(checkpoint!.extension).toBeUndefined();
    expect(checkpoint!.dueAt).toBe("2026-11-17T17:00:00.000Z");
    expect(reading!.dueAt).toBeNull();
  });

  it("moves the bCourses assignment's deadline and links only to where it's turned in", () => {
    const canvas = toAssignment(
      { id: 1500, name: "COMPSCI 169A - LEC 001", course_code: "COMPSCI 169A", term: { name: "Fall 2026" } },
      {
        id: 4521,
        name: "Homework 3",
        due_at: "2026-11-07T07:59:00Z",
        html_url: "https://bcourses.berkeley.edu/courses/1500/assignments/4521",
        points_possible: 10,
        submission_types: ["external_tool"],
      },
    );
    const gradescope = {
      ...canvas,
      platform: "gradescope" as const,
      id: "77",
      url: "https://www.gradescope.com/courses/880/assignments/77",
      submitAt: undefined,
      course: { platform: "gradescope" as const, id: "880", name: "CS 169A", code: "CS 169A" },
    };
    const tasks = mergeAssignments([canvas, gradescope, ...parseCoursePage(COURSE_PAGE, CS169A, NOW)]);
    const hw3 = tasks.find((t) => t.sources.some((s) => s.id === "901"))!;
    expect(hw3.sources.map((s) => s.platform)).toEqual(["gradescope", "canvas", "flextensions"]);
    expect(hw3.dueAt).toBe("2026-11-10T07:59:00.000Z");
    expect(canvas.submitAt).toBe("tool");
  });

  it("says to sign in when Flextensions sends you to its front page", async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, url: "https://flextensions.berkeley.edu/", text: async () => "<a>Log in</a>" })) as unknown as typeof fetch;
    await expect(fetchFlextensions(fetchImpl, NOW)).rejects.toThrow(/Sign in to flextensions\.berkeley\.edu/);
  });

  it("reads every class, skipping one that turned extensions off", async () => {
    const pages: Record<string, string> = { "/courses": COURSES, "/courses/42": COURSE_PAGE };
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname;
      // CS 160 has extensions off: back to /courses.
      const landed = pages[path] ? path : "/courses";
      return { ok: true, status: 200, url: `https://flextensions.berkeley.edu${landed}`, text: async () => pages[landed]! };
    }) as unknown as typeof fetch;
    const assignments = await fetchFlextensions(fetchImpl, NOW);
    expect(assignments.map((a) => a.id)).toEqual(["901", "902", "903", "904"]);
  });
});
