import type { Course } from "@backpack/core";
import { describe, expect, it } from "vitest";
import { canvasApi } from "../src/sources/canvas.js";
import {
  findCourseWebsite,
  launchTargets,
  linksInAnnouncements,
  linksInHtml,
  pickWebsite,
  RECHECK_MS,
  refreshCourseWebsites,
  type Candidate,
} from "../src/sources/websites.js";
import { initialState, memoryStore } from "../src/state.js";
import { missingWebsites, normalizeWebsiteUrl, type CourseWebsite } from "../src/websites.js";

const HOST = "bcourses.berkeley.edu";
const NOW = Date.parse("2026-11-04T12:00:00Z");

const course = (code: string, id = "1500"): Course => ({ platform: "canvas", id, name: `${code} - LEC 001`, code });
const CS61A = course("COMPSCI 61A");

type Route = { json?: unknown; html?: string; status?: number } | "network-error";

/** A fake bCourses: maps request paths to JSON or HTML. Unknown paths are 404s. */
function fakeCanvas(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const path = url.replace(`https://${HOST}`, "");
    calls.push(path);
    const route = routes[path];
    if (route === "network-error") throw new TypeError("Failed to fetch");
    if (!route) return new Response("not found", { status: 404 });
    const body = route.html ?? `while(1);${JSON.stringify(route.json)}`;
    return new Response(body, { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const coursePaths = (id: number | string) => ({
  tabs: `/api/v1/courses/${id}/tabs`,
  syllabus: `/api/v1/courses/${id}?include[]=syllabus_body`,
  front: `/api/v1/courses/${id}/front_page`,
  modules: `/api/v1/courses/${id}/modules?include[]=items&per_page=100`,
  announcements: `/api/v1/courses/${id}/discussion_topics?only_announcements=true&per_page=100`,
});
const COURSES = "/api/v1/users/self/courses?enrollment_state=active&per_page=100";

describe("normalizeWebsiteUrl", () => {
  it("adds https and cleans up what students type", () => {
    expect(normalizeWebsiteUrl("cs61a.org")).toBe("https://cs61a.org/");
    expect(normalizeWebsiteUrl("  https://inst.eecs.berkeley.edu/~cs61c/fa26/ ")).toBe(
      "https://inst.eecs.berkeley.edu/~cs61c/fa26/",
    );
    expect(normalizeWebsiteUrl("http://eecs16a.org")).toBe("http://eecs16a.org/");
  });

  it("rejects things that aren't web addresses", () => {
    expect(normalizeWebsiteUrl("")).toBeNull();
    expect(normalizeWebsiteUrl("not a website")).toBeNull();
    expect(normalizeWebsiteUrl("localhost")).toBeNull();
    expect(normalizeWebsiteUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeWebsiteUrl("mailto:staff@cs61a.org")).toBeNull();
  });
});

describe("linksInHtml", () => {
  it("keeps the sentence around a link and finds addresses that aren't linked", () => {
    const html = `
      <p>Course website: <a href="https://cs61a.org/">cs61a.org</a></p>
      <p>Lecture recordings are at https://www.youtube.com/playlist?list=abc.</p>
      <a href="/courses/1500/files/9">Syllabus PDF</a>`;
    expect(linksInHtml(html, "Syllabus")).toEqual([
      { url: "https://cs61a.org/", context: "cs61a.org Course website: cs61a.org", where: "Syllabus" },
      {
        url: "https://www.youtube.com/playlist?list=abc",
        context: "Lecture recordings are at https://www.youtube.com/playlist?list=abc.",
        where: "Syllabus",
      },
    ]);
  });

  it("handles empty pages", () => {
    expect(linksInHtml(null, "Home page")).toEqual([]);
    expect(linksInHtml("", "Home page")).toEqual([]);
  });
});

describe("pickWebsite", () => {
  const pick = (candidates: Omit<Candidate, "where">[], c = CS61A, where: Candidate["where"] = "Syllabus") =>
    pickWebsite(
      candidates.map((x) => ({ ...x, where })),
      c,
      HOST,
    )?.url ?? null;

  it("picks the link called the course website over Piazza, Ed, Zoom, Gradescope and Google Docs", () => {
    expect(
      pick([
        { url: "https://piazza.com/berkeley/fall2026/cs61a", context: "Piazza (course website for questions)" },
        { url: "https://edstem.org/us/courses/123", context: "Class website discussion forum on Ed" },
        { url: "https://berkeley.zoom.us/j/123", context: "Lecture Zoom" },
        { url: "https://www.gradescope.com/courses/9", context: "Gradescope" },
        { url: "https://docs.google.com/document/d/x", context: "Course website mirror" },
        { url: "https://cs61a.org/", context: "Course website" },
      ]),
    ).toBe("https://cs61a.org/");
  });

  it("recognizes sites named after the course, even without the word 'website'", () => {
    expect(pick([{ url: "https://cs169a.org/", context: "Materials" }], course("COMPSCI 169A"))).toBe("https://cs169a.org/");
    expect(pick([{ url: "https://ds100.org/fa26/", context: "Class materials" }], course("DATA C100"))).toBe(
      "https://ds100.org/fa26/",
    );
    // CS 70's site is eecs70.org: the catalog name and the site's name differ.
    expect(pick([{ url: "https://www.eecs70.org/", context: "Notes" }], course("COMPSCI 70"))).toBe("https://www.eecs70.org/");
    expect(pick([{ url: "https://inst.eecs.berkeley.edu/~cs61c/fa26/", context: "Notes" }], course("COMPSCI 61C"))).toBe(
      "https://inst.eecs.berkeley.edu/~cs61c/fa26/",
    );
  });

  it("prefers the site itself over a page deep inside it or a tool on a subdomain", () => {
    expect(
      pick([
        { url: "https://cs61a.org/hw/hw01/", context: "Homework 1" },
        { url: "https://oh.cs61a.org/", context: "Office hours queue" },
        { url: "https://cs61a.org/", context: "See the schedule" },
      ]),
    ).toBe("https://cs61a.org/");
    expect(pick([{ url: "https://oh.cs61a.org/", context: "Office hours queue" }])).toBeNull();
  });

  it("ignores bCourses itself, files, and code repositories that only mention the course", () => {
    expect(
      pick([
        { url: "https://bcourses.berkeley.edu/courses/1500/pages/home", context: "Course homepage" },
        { url: "https://cs61a.org/assets/syllabus.pdf", context: "Course website PDF" },
        { url: "https://github.com/someone/cs61a-hw1/tree/main/src", context: "Starter code" },
      ]),
    ).toBeNull();
  });

  it("finds nothing for a bCourses site that isn't a class", () => {
    const orientation: Course = { platform: "canvas", id: "77", name: "Golden Bear Orientation 2026" };
    expect(
      pick(
        [
          { url: "https://uhs.berkeley.edu/", context: "University Health Services" },
          { url: "https://dsp.berkeley.edu/", context: "Disabled Students' Program" },
        ],
        orientation,
      ),
    ).toBeNull();
  });

  it("prefers a navigation tab over a link in the syllabus", () => {
    const candidates: Candidate[] = [
      { url: "https://cs61a.org/fa26/", context: "Course website", where: "Syllabus" },
      { url: "https://cs61a.org/", context: "Course Website", where: "Navigation tab" },
    ];
    expect(pickWebsite(candidates, CS61A, HOST)?.url).toBe("https://cs61a.org/");
  });
});

describe("linksInAnnouncements", () => {
  const cs160 = course("COMPSCI 160", "1600");

  it("counts an announcement's title for the one site it links", () => {
    const candidates = linksInAnnouncements([
      {
        title: "Our course website is live",
        message: `<p>Check it out <a href="https://sites.google.com/berkeley.edu/hci-fa26">here</a>, and the
          <a href="https://sites.google.com/berkeley.edu/hci-fa26/schedule">schedule</a>.</p>`,
      },
    ]);
    expect(pickWebsite(candidates, cs160, HOST)?.url).toBe("https://sites.google.com/berkeley.edu/hci-fa26");
  });

  it("doesn't credit the title to any one link when the announcement links several sites", () => {
    const candidates = linksInAnnouncements([
      {
        title: "Course website and section sign-ups",
        message: `<p><a href="https://forms.office.com/r/abc">Sign up</a> · <a href="https://sites.google.com/view/hci">here</a></p>`,
      },
    ]);
    expect(candidates.every((c) => !/website/i.test(c.context))).toBe(true);
    expect(pickWebsite(candidates, cs160, HOST)).toBeNull();
  });
});

describe("launchTargets", () => {
  it("reads the destination from an LTI 1.1 Redirect Tool launch form", () => {
    const html = `<form action="https://www.edu-apps.org/redirect" method="POST" target="tool_content" id="tool_form">
      <input type="hidden" name="oauth_consumer_key" value="x" />
      <input type="hidden" name="custom_url" value="https://cs61a.org/" />
    </form>`;
    expect(launchTargets(html)).toEqual(["https://cs61a.org/"]);
  });

  it("reads the destination from the custom claim of an LTI 1.3 id_token", () => {
    const claims = { "https://purl.imsglobal.org/spec/lti/claim/custom": { url: "https://eecs16a.org/" } };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const html = `<form action="https://redirect.instructure.com/launch" method="POST">
      <input type="hidden" name="id_token" value="eyJhbGciOiJSUzI1NiJ9.${payload}.signature" />
    </form>`;
    expect(launchTargets(html)).toEqual(["https://eecs16a.org/"]);
  });

  it("finds nothing on an ordinary page", () => {
    expect(launchTargets("<p>Nothing to launch</p>")).toEqual([]);
  });
});

describe("findCourseWebsite", () => {
  const paths = coursePaths(1500);

  it("follows a 'Course Website' navigation tab to where it redirects", async () => {
    const { fetchImpl } = fakeCanvas({
      [paths.tabs]: {
        json: [
          { id: "home", label: "Home", type: "internal", html_url: "/courses/1500" },
          { id: "context_external_tool_5", label: "Course Website", type: "external", html_url: "/courses/1500/external_tools/5" },
          { id: "context_external_tool_6", label: "Gradescope", type: "external", html_url: "/courses/1500/external_tools/6" },
        ],
      },
      "/courses/1500/external_tools/5": { html: `<form id="tool_form"><input name="custom_url" value="https://cs61a.org/"></form>` },
      [paths.syllabus]: { json: { syllabus_body: "<p>See Ed for announcements.</p>" } },
    });
    expect(await findCourseWebsite(canvasApi(HOST, fetchImpl), CS61A)).toEqual({ url: "https://cs61a.org/", where: "Navigation tab" });
  });

  it("finds the link on the Home page, and skips parts of the course students can't see", async () => {
    const { fetchImpl } = fakeCanvas({
      [paths.tabs]: { json: [] },
      [paths.front]: { json: { body: `<h2>Welcome!</h2><p>Class website: <a href="https://cs61a.org">cs61a.org</a></p>` } },
      [paths.modules]: { json: { message: "unauthorized" }, status: 401 },
    });
    expect(await findCourseWebsite(canvasApi(HOST, fetchImpl), CS61A)).toEqual({ url: "https://cs61a.org/", where: "Home page" });
  });

  it("finds an External URL item in Modules", async () => {
    const { fetchImpl } = fakeCanvas({
      [paths.modules]: {
        json: [{ items: [{ type: "ExternalUrl", title: "Course Website", external_url: "https://cs61a.org/" }] }],
      },
    });
    expect(await findCourseWebsite(canvasApi(HOST, fetchImpl), CS61A)).toEqual({ url: "https://cs61a.org/", where: "Modules" });
  });

  it("finds a website the professor linked in an announcement", async () => {
    const cs160 = course("COMPSCI 160", "1600");
    const { fetchImpl } = fakeCanvas({
      [coursePaths(1600).announcements]: {
        json: [
          { title: "Midterm logistics", message: `<p>Join on <a href="https://berkeley.zoom.us/j/1">Zoom</a>.</p>` },
          {
            title: "Welcome to CS 160!",
            message: `<p>Hi everyone! All course materials are on
              <a href="https://inst.eecs.berkeley.edu/~cs160/fa26/">our website</a>.
              Questions go on <a href="https://edstem.org/us/courses/9">Ed</a>.</p>`,
          },
        ],
      },
    });
    expect(await findCourseWebsite(canvasApi(HOST, fetchImpl), cs160)).toEqual({
      url: "https://inst.eecs.berkeley.edu/~cs160/fa26/",
      where: "Announcements",
    });
  });

  it("says null when there's no website, but undefined when it couldn't finish reading", async () => {
    const empty = fakeCanvas({ [paths.tabs]: { json: [] }, [paths.syllabus]: { json: { syllabus_body: "" } } });
    expect(await findCourseWebsite(canvasApi(HOST, empty.fetchImpl), CS61A)).toBeNull();

    const offline = fakeCanvas({ [paths.tabs]: "network-error", [paths.syllabus]: "network-error" });
    expect(await findCourseWebsite(canvasApi(HOST, offline.fetchImpl), CS61A)).toBeUndefined();
  });
});

describe("refreshCourseWebsites", () => {
  const cs61a = coursePaths(1500);
  const cs70 = coursePaths(1600);
  const routes = (): Record<string, Route> => ({
    [COURSES]: {
      json: [
        { id: 1500, name: "COMPSCI 61A - LEC 001", course_code: "COMPSCI 61A" },
        { id: 1600, name: "COMPSCI 70 - LEC 001", course_code: "COMPSCI 70" },
        { id: 1700, access_restricted_by_date: true },
      ],
    },
    [cs61a.syllabus]: { json: { syllabus_body: `<p>Course website: <a href="https://cs61a.org/">cs61a.org</a></p>` } },
    [cs70.syllabus]: { json: { syllabus_body: "<p>Welcome to CS 70.</p>" } },
  });
  const canvasOn = { platforms: ["canvas" as const], canvasHost: HOST };

  it("saves found websites and flags the courses it couldn't find one for", async () => {
    const store = memoryStore(canvasOn);
    await refreshCourseWebsites(store, HOST, { now: NOW, fetchImpl: fakeCanvas(routes()).fetchImpl });

    expect(store.state.courseWebsites).toEqual({
      "1500": {
        label: "CS 61A",
        name: "COMPSCI 61A - LEC 001",
        url: "https://cs61a.org/",
        status: "found",
        foundIn: "Syllabus",
        checkedAt: NOW,
      },
      "1600": { label: "CS 70", name: "COMPSCI 70 - LEC 001", url: null, status: "missing", checkedAt: NOW },
    });
    expect(store.state.websitesCheckedAt).toBe(NOW);
    expect(missingWebsites(store.state).map((w) => w.label)).toEqual(["CS 70"]);
  });

  it("looks at a course with no website again weekly, and at new courses right away", async () => {
    const store = memoryStore(canvasOn);
    await refreshCourseWebsites(store, HOST, { now: NOW, fetchImpl: fakeCanvas(routes()).fetchImpl });

    // A few days later: only the course list is read.
    const soon = fakeCanvas(routes());
    await refreshCourseWebsites(store, HOST, { now: NOW + 3 * 24 * 60 * 60 * 1000, fetchImpl: soon.fetchImpl });
    expect(soon.calls).toEqual([COURSES]);

    // The student added a class: it's looked at on the next run, the others aren't.
    const added = fakeCanvas({
      ...routes(),
      [COURSES]: {
        json: [
          { id: 1500, name: "COMPSCI 61A - LEC 001", course_code: "COMPSCI 61A" },
          { id: 1600, name: "COMPSCI 70 - LEC 001", course_code: "COMPSCI 70" },
          { id: 1900, name: "COMPSCI 61B - LEC 001", course_code: "COMPSCI 61B" },
        ],
      },
    });
    await refreshCourseWebsites(store, HOST, { now: NOW + 4 * 24 * 60 * 60 * 1000, fetchImpl: added.fetchImpl });
    expect(added.calls.filter((p) => p !== COURSES).every((p) => p.startsWith("/api/v1/courses/1900"))).toBe(true);
    expect(store.state.courseWebsites["1900"]).toMatchObject({ label: "CS 61B", status: "missing" });

    // A week after the first look, staff have added the CS 70 link; the found CS 61A site isn't read again.
    const later = fakeCanvas({
      ...routes(),
      [cs70.syllabus]: { json: { syllabus_body: `<p>All materials are at <a href="https://www.eecs70.org/">eecs70.org</a></p>` } },
    });
    await refreshCourseWebsites(store, HOST, { now: NOW + RECHECK_MS, fetchImpl: later.fetchImpl });
    expect(later.calls.some((p) => p.startsWith("/api/v1/courses/1500"))).toBe(false);
    expect(store.state.courseWebsites["1600"]).toMatchObject({ url: "https://www.eecs70.org/", status: "found" });
  });

  it("never overwrites a website the student entered or a course they said has none", async () => {
    const mine: CourseWebsite = { label: "CS 61A", name: "COMPSCI 61A - LEC 001", url: "https://my.cs61a.mirror/", status: "manual", checkedAt: 1 };
    const none: CourseWebsite = { label: "CS 70", name: "COMPSCI 70 - LEC 001", url: null, status: "none", checkedAt: 1 };
    const store = memoryStore({ ...canvasOn, courseWebsites: { "1500": mine, "1600": none } });
    const { fetchImpl, calls } = fakeCanvas(routes());
    await refreshCourseWebsites(store, HOST, { force: true, now: NOW, fetchImpl });

    expect(store.state.courseWebsites).toEqual({ "1500": mine, "1600": none });
    expect(calls).toEqual([COURSES]);
    expect(missingWebsites(store.state)).toEqual([]);
  });

  it("keeps an entry the student saved while the look was running", async () => {
    const store = memoryStore(canvasOn);
    const base = fakeCanvas(routes());
    const typed: CourseWebsite = { label: "CS 70", name: "COMPSCI 70 - LEC 001", url: "https://www.eecs70.org/", status: "manual", checkedAt: NOW };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      // The student saves CS 70's website from the menu mid-look.
      if (url.endsWith(cs70.syllabus)) store.state.courseWebsites = { ...store.state.courseWebsites, "1600": typed };
      return base.fetchImpl(url, init);
    }) as typeof fetch;
    await refreshCourseWebsites(store, HOST, { now: NOW, fetchImpl });
    expect(store.state.courseWebsites["1600"]).toEqual(typed);
  });

  it("drops courses that are no longer current", async () => {
    const old: CourseWebsite = { label: "CS 10", name: "COMPSCI 10", url: "https://cs10.org/", status: "found", checkedAt: 1 };
    const store = memoryStore({ ...canvasOn, courseWebsites: { "900": old } });
    await refreshCourseWebsites(store, HOST, { now: NOW, fetchImpl: fakeCanvas(routes()).fetchImpl });
    expect(Object.keys(store.state.courseWebsites).sort()).toEqual(["1500", "1600"]);
  });

  it("doesn't mark courses missing when bCourses can't be reached, and tries again next time", async () => {
    const store = memoryStore(canvasOn);
    const offline = { ...routes(), [cs70.syllabus]: "network-error" as const, [cs70.tabs]: "network-error" as const };
    await refreshCourseWebsites(store, HOST, { now: NOW, fetchImpl: fakeCanvas(offline).fetchImpl });
    expect(store.state.courseWebsites["1600"]).toBeUndefined();
    expect(store.state.websitesCheckedAt).toBeNull();
  });

  it("stops with Canvas's sign-in message when the browser is signed out", async () => {
    const store = memoryStore(canvasOn);
    const { fetchImpl } = fakeCanvas({ [COURSES]: { json: {}, status: 401 } });
    await expect(refreshCourseWebsites(store, HOST, { now: NOW, fetchImpl })).rejects.toThrow(/Sign in to bcourses/);
    expect(store.state.courseWebsites).toEqual({});
  });
});

describe("missingWebsites", () => {
  it("only counts courses while bCourses is turned on", () => {
    const missing: CourseWebsite = { label: "CS 70", name: "COMPSCI 70", url: null, status: "missing", checkedAt: NOW };
    const state = { ...initialState(), courseWebsites: { "1600": missing } };
    expect(missingWebsites({ ...state, platforms: ["canvas"] })).toHaveLength(1);
    expect(missingWebsites({ ...state, platforms: [] })).toHaveLength(0);
  });
});
