import { buildEvents, mergeAssignments, planSync, type Assignment, type ExistingEvent, type Platform } from "@backpack/core";
import type { CalendarClient } from "./google/calendar.js";
import type { State, Store, SyncResult } from "./state.js";

export interface Source {
  platform: Platform;
  fetch(): Promise<Assignment[]>;
}

export type Calendar = Pick<
  CalendarClient,
  | "createCalendar"
  | "calendarExists"
  | "renameCalendar"
  | "deleteCalendar"
  | "listEvents"
  | "insertEvent"
  | "replaceEvent"
  | "deleteEvent"
>;

/** Runs jobs a few at a time, to stay under Google's rate limits. */
async function runLimited(jobs: (() => Promise<void>)[], limit = 4): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One full sync: read each platform, merge, build the events the settings
 * ask for, and bring Backpack's calendars in line with them.
 */
export async function syncOnce(store: Store, sources: Source[], calendar: Calendar, now = Date.now()): Promise<SyncResult> {
  const state = await store.load();
  const errors: State["errors"] = {};
  const cache: State["cache"] = {};

  // A platform that fails keeps its last good read, so its events stay put.
  for (const source of sources) {
    try {
      cache[source.platform] = { fetchedAt: now, assignments: await source.fetch() };
    } catch (error) {
      errors[source.platform] = message(error);
      const previous = state.cache[source.platform];
      if (previous) cache[source.platform] = previous;
    }
  }
  await store.save({ cache, errors });

  try {
    const assignments = Object.values(cache).flatMap((c) => c.assignments);
    const tasks = mergeAssignments(assignments, {
      priority: state.settings.platformPriority,
      courseAliases: state.settings.courseAliases,
    });
    const desired = buildEvents(tasks, state.settings, now);

    // Make sure every calendar the events need exists, with the right name.
    const calendars = { ...state.calendars };
    for (const [key, info] of Object.entries(calendars)) {
      if (!(await calendar.calendarExists(info.id))) delete calendars[key];
    }
    for (const event of desired) {
      const known = calendars[event.calendarKey];
      if (!known) {
        const id = await calendar.createCalendar(event.calendarName, state.settings.timeZone);
        calendars[event.calendarKey] = { id, name: event.calendarName };
      } else if (known.name !== event.calendarName) {
        await calendar.renameCalendar(known.id, event.calendarName);
        calendars[event.calendarKey] = { ...known, name: event.calendarName };
      }
    }
    await store.save({ calendars });

    const existing: ExistingEvent[] = [];
    const othersIn: Record<string, number> = {};
    for (const [key, info] of Object.entries(calendars)) {
      const { backpack, others } = await calendar.listEvents(info.id);
      othersIn[key] = others;
      existing.push(...backpack.map((e) => ({ calendarKey: key, eventId: e.id, taskKey: e.task, hash: e.hash })));
    }

    const plan = planSync(desired, existing, Object.keys(calendars));
    const idOf = (key: string) => calendars[key]!.id;
    await runLimited([
      ...plan.remove.map((e) => () => calendar.deleteEvent(idOf(e.calendarKey), e.eventId)),
      ...plan.update.map((u) => () => calendar.replaceEvent(idOf(u.event.calendarKey), u.eventId, u.event.body)),
      ...plan.create.map((e) => () => calendar.insertEvent(idOf(e.calendarKey), e.body)),
    ]);

    // Calendars left empty by a settings change go, unless the user added their own events.
    for (const key of plan.unusedCalendars) {
      if (othersIn[key] === 0) {
        await calendar.deleteCalendar(idOf(key));
        delete calendars[key];
      }
    }

    const result: SyncResult = {
      at: now,
      created: plan.create.length,
      updated: plan.update.length,
      removed: plan.remove.length,
      unchanged: plan.unchanged,
      tasks: desired.length,
    };
    await store.save({ calendars, lastSync: result, errors });
    return result;
  } catch (error) {
    errors.google = message(error);
    await store.save({ errors });
    throw error;
  }
}
