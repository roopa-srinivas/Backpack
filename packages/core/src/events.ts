import { colorHex, isHexColor, nearestEventColor, type EventColor, type Settings } from "./settings.js";
import { PLATFORM_NAMES, type Task } from "./types.js";

type EventTime = { date: string } | { dateTime: string; timeZone: string };

/** The parts of a Google Calendar event Backpack writes. */
export interface CalendarEventBody {
  summary: string;
  description: string;
  start: EventTime;
  end: EventTime;
  colorId?: string;
  reminders: { useDefault: false; overrides: { method: "popup"; minutes: number }[] };
  source: { title: string; url: string };
  extendedProperties: { private: { backpack: "1"; task: string; hash: string } };
}

export interface DesiredEvent {
  /** Which Backpack calendar it belongs in, e.g. "all" or "course:cs169a". */
  calendarKey: string;
  calendarName: string;
  /** The calendar's own color, for one calendar per class: any "#rrggbb". */
  calendarColor?: string;
  taskKey: string;
  hash: string;
  body: CalendarEventBody;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The calendar date of an instant in a time zone, as YYYY-MM-DD. */
export function dateInZone(instant: number, timeZone: string): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    instant,
  );
}

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
}

function formatDue(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);
}

/** Fills {placeholders} in the title template; unknown ones are left as typed. */
export function renderTitle(template: string, task: Task, courseLabel: string): string {
  const values: Record<string, string> = {
    course: courseLabel,
    title: task.title,
    platform: PLATFORM_NAMES[task.sources[0]!.platform],
    kind: task.kind,
    points: task.points == null ? "" : `${task.points} pts`,
  };
  return template
    .replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)
    .replace(/\s+/g, " ")
    .replace(/\s*[·|-]\s*$/, "") // a trailing separator left by an empty {points}
    .trim();
}

function eventTimes(due: number, settings: Settings): { start: EventTime; end: EventTime } {
  const { style, timeZone } = settings;
  if (style.type === "allDay") {
    // A midnight deadline belongs to the day before: "due 12:00 AM Friday" is Thursday-night work.
    const date = dateInZone(due - MINUTE, timeZone);
    return { start: { date }, end: { date: nextDate(date) } };
  }
  const end = style.type === "deadline" ? due : due - style.hoursBefore * 60 * MINUTE;
  const start = end - style.minutes * MINUTE;
  const at = (t: number) => ({ dateTime: new Date(t).toISOString(), timeZone });
  return { start: at(start), end: at(end) };
}

function calendarFor(task: Task, courseLabel: string, settings: Settings): { key: string; name: string } {
  switch (settings.calendars) {
    case "perCourse":
      return { key: `course:${task.courseKey}`, name: `Backpack · ${courseLabel}` };
    case "perPlatform": {
      const platform = task.sources[0]!.platform;
      return { key: `platform:${platform}`, name: `Backpack · ${PLATFORM_NAMES[platform]}` };
    }
    default:
      return { key: "all", name: "Backpack" };
  }
}

/** FNV-1a: a short fingerprint so unchanged events can be skipped. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The event's color: where the work stands first (submitted, due soon), then
 * the kind of work, then the course. Unset ones fall through to the next.
 */
export function eventColor(task: Task, settings: Settings, now: number): EventColor | undefined {
  const status = settings.statusColors;
  if (task.submitted && status.submitted) return status.submitted;
  if (!task.submitted && status.dueSoon && task.dueAt && Date.parse(task.dueAt) - now <= status.dueSoonHours * 60 * MINUTE) {
    return status.dueSoon;
  }
  const kind = settings.kinds[task.kind]?.color;
  if (kind) return kind;
  const course = settings.courses[task.courseKey]?.color;
  if (!course) return undefined;
  if (!isHexColor(course)) return course;
  // A custom color: exact on the class's own calendar (the event takes the
  // calendar's color), the nearest Google color everywhere else.
  return settings.calendars === "perCourse" ? undefined : nearestEventColor(course);
}

/**
 * Turns tasks into the calendar events the user's settings ask for. Tasks
 * with no due date, in hidden courses, too far in the past, or submitted
 * (when submitted work is hidden) get no event.
 */
export function buildEvents(tasks: Task[], settings: Settings, now = Date.now()): DesiredEvent[] {
  const events: DesiredEvent[] = [];
  for (const task of tasks) {
    if (task.dueAt === null) continue;
    const due = Date.parse(task.dueAt);
    if (due < now - settings.pastDays * DAY) continue;
    const course = settings.courses[task.courseKey] ?? {};
    if (course.hidden) continue;
    if (task.submitted && settings.submitted === "hide") continue;

    const courseLabel = course.label?.trim() || task.courseLabel;
    const kind = settings.kinds[task.kind] ?? {};
    let summary = renderTitle(settings.titleTemplate, task, courseLabel);
    if (kind.emoji?.trim()) summary = `${kind.emoji.trim()} ${summary}`;
    if (task.submitted && settings.submitted === "check") summary = `✓ ${summary}`;
    const color = eventColor(task, settings, now);

    const lines = [`Due ${formatDue(due, settings.timeZone)}`];
    if (task.points != null) lines.push(`${task.points} points`);
    if (task.submitted) lines.push("Submitted");
    lines.push("", ...task.sources.map((s) => `${PLATFORM_NAMES[s.platform]}: ${s.url}`));
    lines.push("", "Added by Backpack");

    const lead = task.sources[0]!;
    const calendar = calendarFor(task, courseLabel, settings);
    const calendarColor = settings.calendars === "perCourse" && course.color ? colorHex(course.color) : undefined;
    const body: Omit<CalendarEventBody, "extendedProperties"> = {
      summary,
      description: lines.join("\n"),
      ...eventTimes(due, settings),
      ...(color ? { colorId: color } : {}),
      reminders: {
        useDefault: false,
        overrides: (kind.reminders ?? settings.reminders).map((minutes) => ({ method: "popup", minutes })),
      },
      source: { title: PLATFORM_NAMES[lead.platform], url: lead.url },
    };
    const hash = fingerprint(JSON.stringify(body));
    events.push({
      calendarKey: calendar.key,
      calendarName: calendar.name,
      ...(calendarColor ? { calendarColor } : {}),
      taskKey: task.key,
      hash,
      body: { ...body, extendedProperties: { private: { backpack: "1", task: task.key, hash } } },
    });
  }
  return events;
}
