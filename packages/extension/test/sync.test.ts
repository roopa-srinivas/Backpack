import { defaultSettings, type Assignment, type CalendarEventBody } from "@backpack/core";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryStore } from "../src/state.js";
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
