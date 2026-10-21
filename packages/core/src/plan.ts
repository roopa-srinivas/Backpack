import type { DesiredEvent } from "./events.js";

/** A Backpack event already on the user's calendar. */
export interface ExistingEvent {
  calendarKey: string;
  eventId: string;
  taskKey: string;
  hash: string;
}

export interface SyncPlan {
  create: DesiredEvent[];
  update: { eventId: string; event: DesiredEvent }[];
  remove: ExistingEvent[];
  /** Calendars Backpack made that nothing belongs in anymore. */
  unusedCalendars: string[];
  unchanged: number;
}

/**
 * Compares what should be on the calendar with what is. Only events Backpack
 * created are ever passed in, so nothing the user made is touched.
 */
export function planSync(desired: DesiredEvent[], existing: ExistingEvent[], knownCalendars: string[] = []): SyncPlan {
  const plan: SyncPlan = { create: [], update: [], remove: [], unusedCalendars: [], unchanged: 0 };

  const byTask = new Map<string, ExistingEvent[]>();
  for (const event of existing) {
    const list = byTask.get(event.taskKey) ?? [];
    list.push(event);
    byTask.set(event.taskKey, list);
  }

  for (const want of desired) {
    const found = byTask.get(want.taskKey) ?? [];
    byTask.delete(want.taskKey);
    const inPlace = found.find((e) => e.calendarKey === want.calendarKey);
    // Copies in another calendar (the calendar setting changed) or duplicates go.
    plan.remove.push(...found.filter((e) => e !== inPlace));
    if (!inPlace) plan.create.push(want);
    else if (inPlace.hash !== want.hash) plan.update.push({ eventId: inPlace.eventId, event: want });
    else plan.unchanged++;
  }
  // Whatever is left belongs to tasks that are gone, hidden or filtered out.
  for (const leftovers of byTask.values()) plan.remove.push(...leftovers);

  const used = new Set(desired.map((d) => d.calendarKey));
  plan.unusedCalendars = knownCalendars.filter((key) => !used.has(key));
  return plan;
}
