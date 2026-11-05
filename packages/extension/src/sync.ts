import {
  assignCourseColors,
  buildEvents,
  isEarlierTerm,
  mergeAssignments,
  newestTerm,
  planSync,
  PLATFORM_NAMES,
  type Assignment,
  type ExistingEvent,
  type Platform,
} from "@backpack/core";
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
  | "setCalendarColor"
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

/**
 * Some sites stop showing a deadline once it has passed (PrairieLearn drops
 * the credit schedule when no credit is left). Keep the date from the last
 * read so the event stays put instead of vanishing.
 */
export function keepKnownDueDates(fresh: Assignment[], previous: Assignment[]): Assignment[] {
  const known = new Map(previous.filter((a) => a.dueAt).map((a) => [a.id, a.dueAt]));
  return fresh.map((a) => (a.dueAt === null && known.has(a.id) ? { ...a, dueAt: known.get(a.id)! } : a));
}

/** How many earlier deadlines each copy remembers. */
const DUE_HISTORY = 5;

/**
 * Notes when each copy's deadline moved since the last read, and the dates
 * it showed before. With these, a copy whose site moved the date still
 * matches a copy on a site that hasn't caught up, and the newer date wins.
 */
export function trackDueDates(fresh: Assignment[], previous: Assignment[], now: number): Assignment[] {
  const before = new Map(previous.map((a) => [a.id, a]));
  return fresh.map((a) => {
    const last = before.get(a.id);
    if (!last) return a;
    const { earlierDueDates, dueMovedAt } = last;
    const moved = Boolean(a.dueAt && last.dueAt && Date.parse(a.dueAt) !== Date.parse(last.dueAt));
    if (!moved) {
      return { ...a, ...(earlierDueDates ? { earlierDueDates } : {}), ...(dueMovedAt ? { dueMovedAt } : {}) };
    }
    return { ...a, earlierDueDates: [...(earlierDueDates ?? []), last.dueAt!].slice(-DUE_HISTORY), dueMovedAt: now };
  });
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
      const previous = state.cache[source.platform]?.assignments ?? [];
      cache[source.platform] = {
        fetchedAt: now,
        assignments: trackDueDates(keepKnownDueDates(await source.fetch(), previous), previous, now),
      };
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
      courseMerges: state.settings.courseMerges,
    });
    // New courses get a color. Settings are read fresh, so a change made on
    // the settings page while this sync was reading isn't overwritten.
    const latestSettings = (await store.load()).settings;
    // Only this semester's classes compete for distinct colors.
    const current = tasks.filter((t) => !isEarlierTerm(newestTerm(t.sources.map((s) => s.course)), now));
    const colored = assignCourseColors(latestSettings, current.map((t) => t.courseKey));
    if (colored) await store.save({ settings: colored });
    const settings = colored ?? latestSettings;
    const desired = buildEvents(tasks, settings, now);

    // The calendar list is shared with your other computers; one may have
    // added a calendar while this one was reading.
    const latest = await store.load();
    const calendars = { ...latest.calendars };
    let madeHere = [...latest.calendarsMadeHere];

    // A platform this computer has never read (say, you haven't signed in to it
    // here yet) leaves a gap in what it knows. If another computer keeps these
    // calendars up to date, writing now would undo that computer's work.
    const unread = sources.filter((s) => errors[s.platform] && !cache[s.platform]).map((s) => s.platform);
    if (unread.length && Object.values(calendars).some((c) => !madeHere.includes(c.id))) {
      const names = unread.map((p) => PLATFORM_NAMES[p]).join(" and ");
      throw new Error(`Calendar left as is until this computer can read ${names} too. Your other computer keeps it up to date meanwhile.`);
    }

    // Make sure every calendar the events need exists, with the right name.
    for (const [key, info] of Object.entries(calendars)) {
      if (!(await calendar.calendarExists(info.id))) delete calendars[key];
    }
    for (const event of desired) {
      const known = calendars[event.calendarKey];
      if (!known) {
        const id = await calendar.createCalendar(event.calendarName, state.settings.timeZone);
        calendars[event.calendarKey] = { id, name: event.calendarName };
        madeHere.push(id);
        // Saved straight away: if the sync stops before the end, the next one
        // reuses this calendar instead of making a second copy of every event.
        await store.save({ calendars, calendarsMadeHere: madeHere });
      } else if (known.name !== event.calendarName) {
        await calendar.renameCalendar(known.id, event.calendarName);
        calendars[event.calendarKey] = { ...known, name: event.calendarName };
      }
      // A class's own calendar shows the class's color, which can be any color.
      const current = calendars[event.calendarKey]!;
      if (event.calendarColor && current.color !== event.calendarColor) {
        await calendar.setCalendarColor(current.id, event.calendarColor);
        calendars[event.calendarKey] = { ...current, color: event.calendarColor };
      }
    }
    await store.save({ calendars });

    // Two computers made the same calendar at once, and the other one's is
    // the shared one: this computer's copy goes, or just Backpack's events in
    // it if you added events of your own.
    const sharedIds = new Set(Object.values(calendars).map((c) => c.id));
    for (const id of madeHere.filter((id) => !sharedIds.has(id))) {
      if (!(await calendar.calendarExists(id))) continue;
      const { backpack, others } = await calendar.listEvents(id);
      if (others === 0) await calendar.deleteCalendar(id);
      else await runLimited(backpack.map((e) => () => calendar.deleteEvent(id, e.id)));
    }
    madeHere = madeHere.filter((id) => sharedIds.has(id));
    await store.save({ calendarsMadeHere: madeHere });

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
        madeHere = madeHere.filter((id) => id !== idOf(key));
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
    await store.save({ calendars, calendarsMadeHere: madeHere, lastSync: result, errors });
    return result;
  } catch (error) {
    errors.google = message(error);
    await store.save({ errors });
    throw error;
  }
}
