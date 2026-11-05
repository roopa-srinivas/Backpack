import { defaultSettings, type Assignment, type CalendarEventBody, type DueAnswer } from "@backpack/core";
import { beforeEach, describe, expect, it } from "vitest";
import { initialState, memoryStore, SHARED_KEYS, type State, type Store } from "../src/state.js";
import { syncOnce, type Calendar, type Source } from "../src/sync.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");

/** An in-memory Google Calendar holding calendars and their events. */
class FakeCalendar implements Calendar {
  calendars = new Map<string, { name: string; events: Map<string, CalendarEventBody | { foreign: true }> }>();
  private nextId = 1;
  calls: string[] = [];

  async createCalendar(name: string) {
    const id = `cal${this.nextId++}`;
    this.calendars.set(id, { name, events: new Map() });
    this.calls.push(`createCalendar ${name}`);
    return id;
  }
  async calendarExists(id: string) {
    return this.calendars.has(id);
  }
  colors = new Map<string, string>();
  async setCalendarColor(id: string, color: string) {
    this.colors.set(id, color);
    this.calls.push(`setCalendarColor ${color}`);
  }
  async renameCalendar(id: string, name: string) {
    this.calendars.get(id)!.name = name;
    this.calls.push(`renameCalendar ${name}`);
  }
  async deleteCalendar(id: string) {
    this.calendars.delete(id);
    this.calls.push(`deleteCalendar ${id}`);
  }
  async listEvents(id: string) {
    const backpack = [];
    let others = 0;
    for (const [eventId, body] of this.calendars.get(id)!.events) {
      if ("foreign" in body) others++;
      else backpack.push({ id: eventId, task: body.extendedProperties.private.task, hash: body.extendedProperties.private.hash });
    }
    return { backpack, others };
  }
  async insertEvent(id: string, body: CalendarEventBody) {
    this.calendars.get(id)!.events.set(`ev${this.nextId++}`, body);
    this.calls.push(`insert ${body.summary}`);
  }
  async replaceEvent(id: string, eventId: string, body: CalendarEventBody) {
    this.calendars.get(id)!.events.set(eventId, body);
    this.calls.push(`replace ${body.summary}`);
  }
  async deleteEvent(id: string, eventId: string) {
    this.calendars.get(id)!.events.delete(eventId);
    this.calls.push(`delete ${eventId}`);
  }
  summaries() {
    return [...this.calendars.values()].flatMap((c) =>
      [...c.events.values()].map((e) => ("foreign" in e ? "(user event)" : `${c.name}: ${e.summary}`)),
    );
  }
}

function canvasAssignment(id: string, title: string, dueAt: string | null, course = "COMPSCI 169A"): Assignment {
  return {
    platform: "canvas",
    id,
    course: { platform: "canvas", id: course, name: `${course} - LEC 001`, code: course },
    title,
    url: `https://bcourses.berkeley.edu/a/${id}`,
    dueAt,
    submitted: false,
    kind: "assignment",
    points: null,
  };
}

let assignments: Assignment[];
const canvas: Source = { platform: "canvas", fetch: async () => assignments };

beforeEach(() => {
  assignments = [
    canvasAssignment("1", "HW 3", "2026-10-24T06:59:00Z"),
    canvasAssignment("2", "Lab 4", "2026-10-22T06:59:00Z", "EECS C106A"),
  ];
});

const store = () => memoryStore({ settings: defaultSettings("America/Los_Angeles") });

describe("syncOnce", () => {
  it("creates a Backpack calendar and an event per assignment, then leaves them alone", async () => {
    const s = store();
    const google = new FakeCalendar();
    const first = await syncOnce(s, [canvas], google, NOW);
    expect(first).toMatchObject({ created: 2, updated: 0, removed: 0, tasks: 2 });
    expect(google.summaries().sort()).toEqual(["Backpack: CS 169A · HW 3", "Backpack: EECS 106A · Lab 4"]);

    google.calls = [];
    const second = await syncOnce(s, [canvas], google, NOW);
    expect(second).toMatchObject({ created: 0, updated: 0, removed: 0, unchanged: 2 });
    expect(google.calls).toEqual([]);
  });

  it("moves an event when the due date changes and removes it when the assignment goes", async () => {
    const s = store();
    const google = new FakeCalendar();
    await syncOnce(s, [canvas], google, NOW);

    assignments[0] = canvasAssignment("1", "HW 3", "2026-10-25T06:59:00Z");
    expect(await syncOnce(s, [canvas], google, NOW)).toMatchObject({ updated: 1, unchanged: 1 });

    assignments = assignments.slice(1);
    expect(await syncOnce(s, [canvas], google, NOW)).toMatchObject({ removed: 1, unchanged: 1 });
    expect(google.summaries()).toEqual(["Backpack: EECS 106A · Lab 4"]);
  });

  it("reuses calendars made by a sync that stopped partway, instead of making copies", async () => {
    const s = store();
    await s.save({ settings: { ...s.state.settings, calendars: "perCourse" } });
    const google = new FakeCalendar();
    const create = google.createCalendar.bind(google);
    // The first course's calendar is made, then the connection drops.
    let made = 0;
    google.createCalendar = async (name: string) => {
      if (made++ === 1) throw new Error("Network dropped");
      return create(name);
    };
    await expect(syncOnce(s, [canvas], google, NOW)).rejects.toThrow("Network dropped");

    google.createCalendar = create;
    await syncOnce(s, [canvas], google, NOW);
    expect([...google.calendars.values()].map((c) => c.name).sort()).toEqual(["Backpack · CS 169A", "Backpack · EECS 106A"]);
    expect(google.summaries()).toHaveLength(2);
  });

  it("puts an assignment listed on bCourses and Gradescope on the calendar once", async () => {
    const s = store();
    const google = new FakeCalendar();
    const gradescope: Source = {
      platform: "gradescope",
      fetch: async () => [
        {
          ...canvasAssignment("77", "Homework 03: Ruby Intro", "2026-10-24T07:00:00Z"),
          platform: "gradescope",
          course: { platform: "gradescope", id: "880", name: "CS 169A Fall 2026" },
          url: "https://www.gradescope.com/courses/880/assignments/77",
        },
      ],
    };
    await syncOnce(s, [canvas, gradescope], google, NOW);
    await syncOnce(s, [canvas, gradescope], google, NOW);
    expect(google.summaries().sort()).toEqual(["Backpack: CS 169A · Homework 03: Ruby Intro", "Backpack: EECS 106A · Lab 4"]);
  });

  it("gives each course its own color, and keeps a color the student picked", async () => {
    const s = store();
    const google = new FakeCalendar();
    await syncOnce(s, [canvas], google, NOW);
    const { cs169a, eecs106a } = s.state.settings.courses;
    expect(cs169a?.color).toBeTruthy();
    expect(eecs106a?.color).toBeTruthy();
    expect(cs169a?.color).not.toBe(eecs106a?.color);

    await s.save({ settings: { ...s.state.settings, courses: { ...s.state.settings.courses, cs169a: { color: "11" } } } });
    await syncOnce(s, [canvas], google, NOW);
    expect(s.state.settings.courses.cs169a?.color).toBe("11");
    const colors = [...google.calendars.values()].flatMap((c) => [...c.events.values()]).map((e) => ("foreign" in e ? null : e.colorId));
    expect(colors.sort()).toEqual(["11", eecs106a!.color].sort());
  });

  it("colors each class's own calendar with any color, once", async () => {
    const s = store();
    await s.save({
      settings: { ...s.state.settings, calendars: "perCourse", courses: { cs169a: { color: "#ff6f61" }, eecs106a: { color: "3" } } },
    });
    const google = new FakeCalendar();
    await syncOnce(s, [canvas], google, NOW);
    expect([...google.colors.values()].sort()).toEqual(["#8E24AA", "#ff6f61"]);

    google.calls = [];
    await syncOnce(s, [canvas], google, NOW);
    expect(google.calls.filter((c) => c.startsWith("setCalendarColor"))).toEqual([]);
  });

  it("puts a cross-listed class on one calendar, however each site names it", async () => {
    const s = store();
    await s.save({ settings: { ...s.state.settings, calendars: "perCourse" } });
    const google = new FakeCalendar();
    const gradescope: Source = {
      platform: "gradescope",
      fetch: async () => [
        {
          ...canvasAssignment("5", "Lab 4: Kinematics", "2026-10-22T06:59:00Z"),
          platform: "gradescope",
          course: { platform: "gradescope", id: "880", name: "ME C106A" },
        },
      ],
    };
    await syncOnce(s, [canvas, gradescope], google, NOW);
    expect([...google.calendars.values()].map((c) => c.name).sort()).toEqual(["Backpack · CS 169A", "Backpack · EECS 106A"]);
    expect(google.summaries()).toHaveLength(2);
  });

  it("doesn't spend a color on a class from an earlier semester", async () => {
    const s = store();
    const google = new FakeCalendar();
    const old: Source = {
      platform: "gradescope",
      fetch: async () => [
        {
          ...canvasAssignment("9", "HW 1", "2026-02-01T07:59:00Z"),
          platform: "gradescope",
          course: { platform: "gradescope", id: "12", name: "CS 61B", term: "Spring 2026" },
        },
      ],
    };
    await syncOnce(s, [canvas, old], google, NOW);
    expect(s.state.settings.courses.cs169a?.color).toBeTruthy();
    expect(s.state.settings.courses.cs61b).toBeUndefined();
  });

  it("keeps the last good events when Canvas can't be reached", async () => {
    const s = store();
    const google = new FakeCalendar();
    await syncOnce(s, [canvas], google, NOW);

    const offline: Source = { platform: "canvas", fetch: async () => Promise.reject(new Error("Sign in to Canvas")) };
    const result = await syncOnce(s, [offline], google, NOW);
    expect(result).toMatchObject({ removed: 0, unchanged: 2 });
    expect(s.state.errors).toEqual({ canvas: "Sign in to Canvas" });
  });

  it("switches to one calendar per course and cleans up the old one", async () => {
    const s = store();
    const google = new FakeCalendar();
    await syncOnce(s, [canvas], google, NOW);

    await s.save({ settings: { ...s.state.settings, calendars: "perCourse" } });
    await syncOnce(s, [canvas], google, NOW);
    expect(google.summaries().sort()).toEqual(["Backpack · CS 169A: CS 169A · HW 3", "Backpack · EECS 106A: EECS 106A · Lab 4"]);
    expect([...google.calendars.values()].map((c) => c.name).sort()).toEqual(["Backpack · CS 169A", "Backpack · EECS 106A"]);
    expect(Object.keys(s.state.calendars).sort()).toEqual(["course:cs169a", "course:eecs106a"]);
  });

  it("never deletes a calendar holding the user's own events", async () => {
    const s = store();
    const google = new FakeCalendar();
    await syncOnce(s, [canvas], google, NOW);
    const id = s.state.calendars.all!.id;
    google.calendars.get(id)!.events.set("mine", { foreign: true });

    await s.save({ settings: { ...s.state.settings, calendars: "perCourse" } });
    await syncOnce(s, [canvas], google, NOW);
    expect(google.calendars.has(id)).toBe(true);
    expect(google.calendars.get(id)!.events.size).toBe(1); // only the user's event is left
  });

  it("renames a course calendar when the user relabels the course", async () => {
    const s = store();
    const google = new FakeCalendar();
    await s.save({ settings: { ...s.state.settings, calendars: "perCourse" } });
    await syncOnce(s, [canvas], google, NOW);

    await s.save({ settings: { ...s.state.settings, courses: { eecs106a: { label: "Robotics" } } } });
    await syncOnce(s, [canvas], google, NOW);
    expect(google.calls).toContain("renameCalendar Backpack · Robotics");
    expect(google.summaries()).toContain("Backpack · Robotics: Robotics · Lab 4");
  });

  it("recreates a calendar the user deleted", async () => {
    const s = store();
    const google = new FakeCalendar();
    await syncOnce(s, [canvas], google, NOW);
    google.calendars.clear();
    expect(await syncOnce(s, [canvas], google, NOW)).toMatchObject({ created: 2 });
  });
});

describe("syncOnce with several platforms", () => {
  it("merges the same homework from Canvas and Gradescope into one event with both links", async () => {
    const s = store();
    const google = new FakeCalendar();
    const gradescope: Source = {
      platform: "gradescope",
      fetch: async () => [
        {
          platform: "gradescope",
          id: "5001",
          course: { platform: "gradescope", id: "880", name: "Software Engineering", code: "CS 169A" },
          title: "Homework 3: Ruby Intro",
          url: "https://www.gradescope.com/courses/880/assignments/5001",
          dueAt: "2026-10-24T06:59:00Z",
          submitted: false,
          kind: "assignment",
          points: 10,
        },
      ],
    };
    await syncOnce(s, [canvas, gradescope], google, NOW);
    expect(google.summaries().sort()).toEqual(["Backpack: CS 169A · Homework 3: Ruby Intro", "Backpack: EECS 106A · Lab 4"]);

    // Unchecking Gradescope: its copy goes, and the Canvas copy takes over the calendar.
    const result = await syncOnce(s, [canvas], google, NOW);
    expect(google.summaries().sort()).toEqual(["Backpack: CS 169A · HW 3", "Backpack: EECS 106A · Lab 4"]);
    expect(result).toMatchObject({ created: 1, removed: 1 });
  });
});

/**
 * Two computers signed in to the same Chrome profile: each has its own local
 * storage, and they share SHARED_KEYS through `synced`, which tests can swap
 * out to act like sync storage that hasn't caught up yet.
 */
function computer(synced: { data: Partial<State> }): Store {
  const local: Partial<State> = {};
  return {
    async load() {
      return structuredClone({ ...initialState(), settings: defaultSettings("America/Los_Angeles"), ...local, ...synced.data });
    },
    async save(patch) {
      for (const [key, value] of Object.entries(structuredClone(patch))) {
        const area: Record<string, unknown> = (SHARED_KEYS as readonly string[]).includes(key) ? synced.data : local;
        area[key] = value;
      }
    },
  };
}

describe("syncing from two computers", () => {
  it("uses the calendar the other computer made, instead of a second copy", async () => {
    const synced = { data: {} };
    const [laptop, desktop] = [computer(synced), computer(synced)];
    const google = new FakeCalendar();
    await syncOnce(laptop, [canvas], google, NOW);
    expect(await syncOnce(desktop, [canvas], google, NOW)).toMatchObject({ created: 0, unchanged: 2 });
    expect(google.calendars.size).toBe(1);
    expect(google.summaries()).toHaveLength(2);
  });

  it("ends up with one calendar when both computers made one before sync storage caught up", async () => {
    const [laptopView, desktopView] = [{ data: {} }, { data: {} }];
    const [laptop, desktop] = [computer(laptopView), computer(desktopView)];
    const google = new FakeCalendar();
    await syncOnce(laptop, [canvas], google, NOW);
    await syncOnce(desktop, [canvas], google, NOW);
    expect(google.summaries()).toHaveLength(4); // every assignment twice, for now

    // Sync storage settles on the desktop's calendar list everywhere.
    laptopView.data = desktopView.data;
    await syncOnce(laptop, [canvas], google, NOW);
    await syncOnce(desktop, [canvas], google, NOW);
    expect(google.calendars.size).toBe(1);
    expect(google.summaries().sort()).toEqual(["Backpack: CS 169A · HW 3", "Backpack: EECS 106A · Lab 4"]);
  });

  it("keeps your own events when removing the extra calendar's copies", async () => {
    const [laptopView, desktopView] = [{ data: {} }, { data: {} }];
    const [laptop, desktop] = [computer(laptopView), computer(desktopView)];
    const google = new FakeCalendar();
    await syncOnce(laptop, [canvas], google, NOW);
    const laptopCalendar = [...google.calendars.keys()][0]!;
    google.calendars.get(laptopCalendar)!.events.set("mine", { foreign: true });
    await syncOnce(desktop, [canvas], google, NOW);

    laptopView.data = desktopView.data;
    await syncOnce(laptop, [canvas], google, NOW);
    expect(google.calendars.get(laptopCalendar)!.events.size).toBe(1);
    expect(google.summaries().sort()).toEqual(["(user event)", "Backpack: CS 169A · HW 3", "Backpack: EECS 106A · Lab 4"]);
  });

  it("leaves the shared calendar alone while a computer can't read one of your sites yet", async () => {
    const synced = { data: {} };
    const [laptop, desktop] = [computer(synced), computer(synced)];
    const google = new FakeCalendar();
    const gradescope: Source = {
      platform: "gradescope",
      fetch: async () => [
        {
          ...canvasAssignment("5001", "HW3: Ruby Intro", "2026-10-24T06:59:00Z"),
          platform: "gradescope",
          course: { platform: "gradescope", id: "880", name: "CS 169A Fall 2026" },
        },
      ],
    };
    await syncOnce(laptop, [canvas, gradescope], google, NOW);
    const before = google.summaries().sort();

    // Not signed in to Gradescope on the desktop yet.
    const signedOut: Source = { platform: "gradescope", fetch: () => Promise.reject(new Error("Sign in to gradescope.com")) };
    google.calls = [];
    await expect(syncOnce(desktop, [canvas, signedOut], google, NOW)).rejects.toThrow(/until this computer can read Gradescope/);
    expect(google.calls).toEqual([]);
    expect(google.summaries().sort()).toEqual(before);
  });

  it("still syncs from a single computer while one of its sites can't be read", async () => {
    const s = store();
    const google = new FakeCalendar();
    const signedOut: Source = { platform: "gradescope", fetch: () => Promise.reject(new Error("Sign in to gradescope.com")) };
    expect(await syncOnce(s, [canvas, signedOut], google, NOW)).toMatchObject({ created: 2 });
    expect(s.state.errors).toEqual({ gradescope: "Sign in to gradescope.com" });
  });
});

describe("keepKnownDueDates", () => {
  it("keeps a deadline a site stopped showing, and nothing else", async () => {
    const { keepKnownDueDates } = await import("../src/sync.js");
    const before = [canvasAssignment("1", "HW 3", "2026-10-24T06:59:00Z"), canvasAssignment("2", "Lab 4", "2026-10-22T06:59:00Z")];
    const after = [canvasAssignment("1", "HW 3", null), canvasAssignment("2", "Lab 4", "2026-10-29T06:59:00Z"), canvasAssignment("3", "HW 4", null)];
    expect(keepKnownDueDates(after, before).map((a) => a.dueAt)).toEqual([
      "2026-10-24T06:59:00Z",
      "2026-10-29T06:59:00Z",
      null,
    ]);
  });
});

describe("when a due date moves", () => {
  const HW3_FRI = "2026-10-24T06:59:00Z";
  const HW3_MON = "2026-10-27T06:59:00Z";
  const HW3_WED = "2026-10-29T06:59:00Z";
  let gradescopeDue: string | null;
  let canvasDue: string | null;
  const gradescope: Source = {
    platform: "gradescope",
    fetch: async () => [
      {
        platform: "gradescope",
        id: "5001",
        course: { platform: "gradescope", id: "880", name: "Software Engineering", code: "CS 169A" },
        title: "Homework 3",
        url: "https://www.gradescope.com/courses/880/assignments/5001",
        dueAt: gradescopeDue,
        submitted: false,
        kind: "assignment",
        points: 10,
      },
    ],
  };
  const canvasOnly: Source = { platform: "canvas", fetch: async () => [canvasAssignment("1", "HW 3", canvasDue)] };

  /** Every Backpack event as [title, end time], plus the event ids, to check it's the same event. */
  const events = (google: FakeCalendar) =>
    [...google.calendars.values()].flatMap((c) =>
      [...c.events].map(([id, e]) => ("foreign" in e ? [id] : [id, e.summary, "dateTime" in e.end ? e.end.dateTime : ""])),
    );

  beforeEach(() => {
    gradescopeDue = HW3_FRI;
    canvasDue = HW3_FRI;
  });

  const answer = async (s: ReturnType<typeof store>, key: string, a: DueAnswer) => {
    const questions = s.state.dueQuestions;
    await s.save({ dueQuestions: { ...questions, [key]: { ...questions[key]!, answer: a, answeredAt: Date.now() } } });
  };
  const KEY = "gradescope:5001";

  it("keeps the calendar's date and asks when Gradescope moves the date and bCourses hasn't", async () => {
    const s = store();
    const google = new FakeCalendar();
    await syncOnce(s, [canvasOnly, gradescope], google, NOW);
    const eventId = events(google)[0]![0];

    gradescopeDue = HW3_MON;
    const result = await syncOnce(s, [canvasOnly, gradescope], google, NOW + 1000);
    expect(result).toMatchObject({ created: 0, updated: 0, removed: 0, newQuestions: [KEY] });
    expect(events(google)).toEqual([[eventId, "CS 169A · Homework 3", "2026-10-24T06:59:00.000Z"]]);
    expect(s.state.dueQuestions[KEY]).toMatchObject({
      courseLabel: "CS 169A",
      title: "Homework 3",
      heldDueAt: HW3_FRI,
      answer: { kind: "unanswered" },
      options: [
        { dueAt: HW3_FRI, platforms: ["canvas"] },
        { dueAt: HW3_MON, platforms: ["gradescope"] },
      ],
    });

    // Asked once: the next sync doesn't ask again.
    expect(await syncOnce(s, [canvasOnly, gradescope], google, NOW + 2000)).toMatchObject({ updated: 0, newQuestions: [] });

    // bCourses catches up: no more disagreement, so the event moves and the question goes.
    canvasDue = HW3_MON;
    expect(await syncOnce(s, [canvasOnly, gradescope], google, NOW + 3000)).toMatchObject({ created: 0, updated: 1, removed: 0 });
    expect(events(google)).toEqual([[eventId, "CS 169A · Homework 3", "2026-10-27T06:59:00.000Z"]]);
    expect(s.state.dueQuestions).toEqual({});
  });

  it("moves the event to the date you choose, or type in, and doesn't ask again", async () => {
    const s = store();
    const google = new FakeCalendar();
    await syncOnce(s, [canvasOnly, gradescope], google, NOW);
    const eventId = events(google)[0]![0];
    canvasDue = HW3_MON;
    expect(await syncOnce(s, [canvasOnly, gradescope], google, NOW + 1000)).toMatchObject({ updated: 0, newQuestions: [KEY] });

    await answer(s, KEY, { kind: "date", dueAt: HW3_MON, custom: false });
    expect(await syncOnce(s, [canvasOnly, gradescope], google, NOW + 2000)).toMatchObject({ updated: 1, newQuestions: [], dueReminders: [] });
    expect(events(google)).toEqual([[eventId, "CS 169A · Homework 3", "2026-10-27T06:59:00.000Z"]]);

    await answer(s, KEY, { kind: "date", dueAt: "2026-10-28T19:00:00.000Z", custom: true });
    await syncOnce(s, [canvasOnly, gradescope], google, NOW + 3000);
    expect(events(google).map((e) => e[2])).toEqual(["2026-10-28T19:00:00.000Z"]);
  });

  it("leaves the calendar alone and stops asking when you say not to change it", async () => {
    const s = store();
    const google = new FakeCalendar();
    await syncOnce(s, [canvasOnly, gradescope], google, NOW);
    gradescopeDue = HW3_MON;
    await syncOnce(s, [canvasOnly, gradescope], google, NOW + 1000);
    await answer(s, KEY, { kind: "keep" });
    for (const at of [NOW + 2000, NOW + 3 * 86_400_000]) {
      expect(await syncOnce(s, [canvasOnly, gradescope], google, at)).toMatchObject({ updated: 0, newQuestions: [], dueReminders: [] });
    }
    expect(events(google).map((e) => e[2])).toEqual(["2026-10-24T06:59:00.000Z"]);

    // A site moving again is something new to ask about. The calendar still shows Friday meanwhile.
    gradescopeDue = HW3_WED;
    expect(await syncOnce(s, [canvasOnly, gradescope], google, NOW + 4000)).toMatchObject({ updated: 0, newQuestions: [KEY] });
    expect(s.state.dueQuestions[KEY]).toMatchObject({ heldDueAt: HW3_FRI, answer: { kind: "unanswered" } });
  });

  it("reminds you around the time you asked, keeping the calendar's date until then", async () => {
    const s = store();
    const google = new FakeCalendar();
    await syncOnce(s, [canvasOnly, gradescope], google, NOW);
    gradescopeDue = HW3_MON;
    await syncOnce(s, [canvasOnly, gradescope], google, NOW + 1000);
    const remindAt = NOW + 2 * 3_600_000;
    await answer(s, KEY, { kind: "later", remindAt });
    expect(await syncOnce(s, [canvasOnly, gradescope], google, remindAt - 3_600_000)).toMatchObject({ newQuestions: [], dueReminders: [] });
    expect(await syncOnce(s, [canvasOnly, gradescope], google, remindAt - 20 * 60_000)).toMatchObject({ newQuestions: [], dueReminders: [KEY] });
    expect(events(google).map((e) => e[2])).toEqual(["2026-10-24T06:59:00.000Z"]);
  });

  it("asks about new work the sites disagree on from the start, showing the turn-in site's date meanwhile", async () => {
    const s = store();
    const google = new FakeCalendar();
    canvasDue = "2026-10-24T00:00:00Z"; // Friday 5 PM on bCourses, 11:59 PM on Gradescope
    expect(await syncOnce(s, [canvasOnly, gradescope], google, NOW)).toMatchObject({ created: 1, newQuestions: [KEY] });
    expect(events(google).map((e) => e[2])).toEqual(["2026-10-24T06:59:00.000Z"]);
    expect(s.state.dueQuestions[KEY]!.heldDueAt).toBeNull();
  });

  it("doesn't ask about submitted work, past work, or hidden classes", async () => {
    canvasDue = HW3_MON;
    const submitted: Source = { platform: "gradescope", fetch: async () => (await gradescope.fetch()).map((a) => ({ ...a, submitted: true })) };
    const s1 = store();
    expect(await syncOnce(s1, [canvasOnly, submitted], new FakeCalendar(), NOW)).toMatchObject({ newQuestions: [] });
    const s2 = store();
    expect(await syncOnce(s2, [canvasOnly, gradescope], new FakeCalendar(), Date.parse("2026-10-28T12:00:00Z"))).toMatchObject({ newQuestions: [] });
    const settings = defaultSettings("America/Los_Angeles");
    const s3 = memoryStore({ settings: { ...settings, courses: { cs169a: { hidden: true } } } });
    expect(await syncOnce(s3, [canvasOnly, gradescope], new FakeCalendar(), NOW)).toMatchObject({ newQuestions: [] });
  });

  it("moves the event when an extension is approved on Flextensions", async () => {
    const s = store();
    const google = new FakeCalendar();
    let extension: Assignment["extension"] = { status: "pending", originalDueAt: null };
    const flextensions: Source = {
      platform: "flextensions",
      fetch: async () => [
        {
          platform: "flextensions",
          id: "901",
          course: { platform: "flextensions", id: "42", name: "COMPSCI 169A - LEC 001", code: "COMPSCI 169A", sameAs: "canvas:COMPSCI 169A" },
          title: "HW 3",
          url: "https://bcourses.berkeley.edu/a/1",
          dueAt: extension?.status === "approved" ? HW3_MON : HW3_FRI,
          submitted: false,
          kind: "assignment",
          submitAt: "elsewhere",
          sameAs: "canvas:1",
          ...(extension ? { extension } : {}),
        },
      ],
    };
    await syncOnce(s, [canvasOnly, gradescope, flextensions], google, NOW);
    const eventId = events(google)[0]![0];
    extension = { status: "approved", originalDueAt: HW3_FRI };
    expect(await syncOnce(s, [canvasOnly, gradescope, flextensions], google, NOW + 1000)).toMatchObject({ created: 0, updated: 1, removed: 0 });
    expect(events(google)).toEqual([[eventId, "CS 169A · Homework 3", "2026-10-27T06:59:00.000Z"]]);
  });
});

describe("trackDueDates", () => {
  it("notes when a deadline moved and remembers the dates before, carrying both forward", async () => {
    const { trackDueDates } = await import("../src/sync.js");
    const first = [canvasAssignment("1", "HW 3", "2026-10-24T06:59:00Z"), canvasAssignment("2", "Lab 4", "2026-10-22T06:59:00Z")];
    const second = trackDueDates(
      [canvasAssignment("1", "HW 3", "2026-10-27T06:59:00Z"), canvasAssignment("2", "Lab 4", "2026-10-22T06:59:00.000Z")],
      first,
      NOW,
    );
    expect(second[0]).toMatchObject({ earlierDueDates: ["2026-10-24T06:59:00Z"], dueMovedAt: NOW });
    // The same instant written differently isn't a move.
    expect(second[1]!.dueMovedAt).toBeUndefined();

    const third = trackDueDates([canvasAssignment("1", "HW 3", "2026-10-27T06:59:00Z")], second, NOW + 1000);
    expect(third[0]).toMatchObject({ earlierDueDates: ["2026-10-24T06:59:00Z"], dueMovedAt: NOW });

    let history = third;
    for (let day = 28; day <= 33; day++) {
      history = trackDueDates([canvasAssignment("1", "HW 3", `2026-10-${String(day).padStart(2, "0")}T06:59:00Z`)], history, NOW + day);
    }
    expect(history[0]!.earlierDueDates).toHaveLength(5);
    expect(history[0]!.dueMovedAt).toBe(NOW + 33);
  });
});
