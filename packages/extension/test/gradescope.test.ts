import { describe, expect, it } from "vitest";
import {
  fetchGradescope,
  isLoginPage,
  parseCourseList,
  parseCoursePage,
  parseGradescopeTime,
  type GradescopeCourse,
} from "../src/sources/gradescope.js";

// Trimmed copies of the markup Gradescope serves students.
const ACCOUNT = `
<main>
  <h1 class="pageHeading">Instructor Courses</h1>
  <div class="courseList">
    <div class="courseList--term pageSubheading">Fall 2026</div>
    <div class="courseList--coursesForTerm">
      <a class="courseBox" href="/courses/111"><h3 class="courseBox--shortname">CS 61A</h3><div class="courseBox--name">TA section</div></a>
    </div>
  </div>
  <h1 class="pageHeading">Student Courses</h1>
  <div class="courseList">
    <div class="courseList--term pageSubheading">Fall 2026</div>
    <div class="courseList--coursesForTerm">
      <a class="courseBox" href="/courses/880">
        <h3 class="courseBox--shortname">CS 169A</h3>
        <div class="courseBox--name">Software Engineering</div>
        <div class="courseBox--assignments">4 assignments</div>
      </a>
      <a class="courseBox" href="/courses/881"><h3 class="courseBox--shortname">CS 61C</h3><div class="courseBox--name">Great Ideas in Computer Architecture</div></a>
      <button class="courseBox courseBox-new">Add a course</button>
    </div>
    <div class="courseList--term pageSubheading">Spring 2026</div>
    <div class="courseList--coursesForTerm">
      <a class="courseBox" href="/courses/700"><h3 class="courseBox--shortname">CS 70</h3><div class="courseBox--name">Discrete Math</div></a>
    </div>
  </div>
</main>`;

const COURSE_PAGE = `
<table id="assignments-student-table">
  <thead><tr><th>Name</th><th>Status</th><th>Released</th></tr></thead>
  <tbody>
    <tr role="row">
      <th class="table--primaryLink" scope="row"><a href="/courses/880/assignments/5001/submissions/90">HW 3: Ruby Intro</a></th>
      <td class="submissionStatus"><div class="submissionStatus--score">8.0 / 10.0</div></td>
      <td class="submissionTimeChart">
        <time class="submissionTimeChart--releaseDate" datetime="2026-10-10 09:00:00 -0700">Oct 10</time>
        <time class="submissionTimeChart--dueDate" datetime="2026-10-23 23:59:00 -0700">Oct 23 at 11:59PM</time>
      </td>
    </tr>
    <tr role="row">
      <th class="table--primaryLink" scope="row"><button class="js-submitAssignment" data-assignment-id="5002">Project 2A</button></th>
      <td class="submissionStatus"><div class="submissionStatus--text">No Submission</div></td>
      <td class="submissionTimeChart"><time class="submissionTimeChart--dueDate" datetime="2026-11-06 23:59:00 -0800">Nov 06</time></td>
    </tr>
    <tr role="row">
      <th class="table--primaryLink" scope="row">Midterm 1</th>
      <td class="submissionStatus"><div class="submissionStatus--text">Submitted</div></td>
      <td class="submissionTimeChart"></td>
    </tr>
  </tbody>
</table>`;

const CS169A: GradescopeCourse = { id: "880", shortName: "CS 169A", name: "Software Engineering", term: "Fall 2026" };

describe("Gradescope parsing", () => {
  it("lists only this term's student courses", () => {
    expect(parseCourseList(ACCOUNT)).toEqual([
      CS169A,
      { id: "881", shortName: "CS 61C", name: "Great Ideas in Computer Architecture", term: "Fall 2026" },
    ]);
  });

  it("works when the account page has no headings (student-only accounts)", () => {
    const studentOnly = ACCOUNT.replace(/<h1[^]*?<h1 class="pageHeading">Student Courses<\/h1>/, "");
    expect(parseCourseList(studentOnly).map((c) => c.id)).toEqual(["880", "881"]);
  });

  it("converts Gradescope's due times to ISO instants", () => {
    expect(parseGradescopeTime("2026-10-23 23:59:00 -0700")).toBe("2026-10-24T06:59:00.000Z");
    expect(parseGradescopeTime("2026-11-06 23:59 -0800")).toBe("2026-11-07T07:59:00.000Z");
    expect(parseGradescopeTime(undefined)).toBeNull();
    expect(parseGradescopeTime("soon")).toBeNull();
  });

  it("reads graded, open and text-only assignments", () => {
    const [hw, proj, mt] = parseCoursePage(COURSE_PAGE, CS169A);
    expect(hw).toEqual({
      platform: "gradescope",
      id: "5001",
      course: { platform: "gradescope", id: "880", name: "Software Engineering", code: "CS 169A", term: "Fall 2026" },
      title: "HW 3: Ruby Intro",
      url: "https://www.gradescope.com/courses/880/assignments/5001/submissions/90",
      dueAt: "2026-10-24T06:59:00.000Z",
      submitted: true,
      kind: "assignment",
      points: 10,
    });
    expect(proj).toMatchObject({
      id: "5002",
      url: "https://www.gradescope.com/courses/880/assignments/5002",
      dueAt: "2026-11-07T07:59:00.000Z",
      submitted: false,
      kind: "project",
      points: null,
    });
    expect(mt).toMatchObject({ id: "880:midterm 1", dueAt: null, submitted: true, kind: "exam" });
  });

  it("spots the sign-in page", () => {
    expect(isLoginPage('<form><input name="session[email]"></form>')).toBe(true);
    expect(isLoginPage(ACCOUNT)).toBe(false);
  });
});

describe("fetchGradescope", () => {
  it("reads every current course with the browser's login", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const pages: Record<string, string> = {
      "/account": ACCOUNT,
      "/courses/880": COURSE_PAGE,
      "/courses/881": "<table id='assignments-student-table'><tbody></tbody></table>",
    };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      const body = pages[url.replace("https://www.gradescope.com", "")];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
    }) as typeof fetch;

    const assignments = await fetchGradescope(fetchImpl);
    expect(assignments.map((a) => a.title)).toEqual(["HW 3: Ruby Intro", "Project 2A", "Midterm 1"]);
    expect(calls.every((c) => c.init?.credentials === "include")).toBe(true);
  });

  it("asks the student to sign in when Gradescope serves its login page", async () => {
    const fetchImpl = (async () => new Response('<input name="session[email]">')) as unknown as typeof fetch;
    await expect(fetchGradescope(fetchImpl)).rejects.toThrow("Sign in to gradescope.com");
  });
});
