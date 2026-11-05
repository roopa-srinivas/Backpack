/** How far a time zone is ahead of UTC at an instant, in milliseconds. */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - Math.floor(instant / 60_000) * 60_000;
}

/** The instant a wall-clock time in a time zone happens. `month` counts from 0. */
export function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  // Twice, so a guess on the far side of a daylight-saving change corrects itself.
  const first = wall - zoneOffset(wall, timeZone);
  return wall - zoneOffset(first, timeZone);
}

/** An instant as a date-and-time field's value in a time zone: "2026-10-23T23:59". */
export function toLocalInput(instant: number, timeZone: string): string {
  return new Date(instant + zoneOffset(instant, timeZone)).toISOString().slice(0, 16);
}

/** A date-and-time field's value ("2026-10-23T23:59") in a time zone, as an instant; null if it isn't one. */
export function fromLocalInput(value: string, timeZone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  return zonedInstant(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), timeZone);
}

/** "Fri, Oct 23, 11:59 PM" in a time zone. */
export function formatDue(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);
}
