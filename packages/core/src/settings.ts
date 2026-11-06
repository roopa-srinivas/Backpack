import { DEFAULT_PLATFORM_PRIORITY } from "./merge.js";
import type { AssignmentKind, Platform } from "./types.js";

/** Google Calendar's event color ids ("1" lavender ... "11" tomato). */
export type EventColor = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11";

export const EVENT_COLORS: Record<EventColor, { name: string; hex: string }> = {
  "1": { name: "Lavender", hex: "#7986CB" },
  "2": { name: "Sage", hex: "#33B679" },
  "3": { name: "Grape", hex: "#8E24AA" },
  "4": { name: "Flamingo", hex: "#E67C73" },
  "5": { name: "Banana", hex: "#F6BF26" },
  "6": { name: "Tangerine", hex: "#F4511E" },
  "7": { name: "Peacock", hex: "#039BE5" },
  "8": { name: "Graphite", hex: "#616161" },
  "9": { name: "Blueberry", hex: "#3F51B5" },
  "10": { name: "Basil", hex: "#0B8043" },
  "11": { name: "Tomato", hex: "#D50000" },
};

/** Any color, as "#rrggbb". */
export type HexColor = `#${string}`;

export const isHexColor = (color: unknown): color is HexColor => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color);

/** The hex value of a Google color or a custom one. */
export const colorHex = (color: EventColor | HexColor): string => (isHexColor(color) ? color : EVENT_COLORS[color].hex);

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/**
 * The closest of Google's 11 event colors to any color. Events can only use
 * those 11; a whole calendar can use any color.
 */
export function nearestEventColor(hex: HexColor): EventColor {
  const [r, g, b] = rgb(hex);
  let best: EventColor = "1";
  let bestDistance = Infinity;
  for (const [id, { hex: candidate }] of Object.entries(EVENT_COLORS) as [EventColor, { hex: string }][]) {
    const [cr, cg, cb] = rgb(candidate);
    // Weighted for how eyes see red, green and blue.
    const distance = 2 * (r - cr) ** 2 + 4 * (g - cg) ** 2 + 3 * (b - cb) ** 2;
    if (distance < bestDistance) [best, bestDistance] = [id, distance];
  }
  return best;
}

/** Black or white, whichever reads better on this color. */
export function textColorOn(hex: string): string {
  const [r, g, b] = rgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#1d1d1d" : "#ffffff";
}

/** How a task appears on the calendar. */
export type EventStyle =
  /** An all-day event on the day it's due. */
  | { type: "allDay" }
  /** A short event ending at the due time. */
  | { type: "deadline"; minutes: number }
  /** A work session of `minutes` that ends `hoursBefore` hours before the due time. */
  | { type: "workBlock"; minutes: number; hoursBefore: number };

export interface CourseSettings {
  /** Replaces the detected label, e.g. "Robotics" instead of "EECS 106A". */
  label?: string;
  /**
   * One of Google's colors or any color. Null means the student chose no
   * color; unset means Backpack picks one. Any color shows exactly when each
   * class has its own calendar, and as the nearest Google color otherwise.
   */
  color?: EventColor | HexColor | null;
  hidden?: boolean;
}

/** How one kind of work (exams, labs, ...) looks, whatever the course. */
export interface KindSettings {
  /** Used instead of the course color. */
  color?: EventColor;
  /** Popup reminders, in minutes before; used instead of the general reminders. */
  reminders?: number[];
  /** Put before the title, e.g. "🎯". */
  emoji?: string;
}

/** Colors that show where work stands; they win over kind and course colors. */
export interface StatusColors {
  submitted?: EventColor;
  /** For work not yet turned in that's due within `dueSoonHours`, or overdue. */
  dueSoon?: EventColor;
  dueSoonHours: number;
}

export interface Settings {
  /** One calendar for everything, one per course, or one per platform. */
  calendars: "single" | "perCourse" | "perPlatform";
  /** Event title. Placeholders: {course} {title} {platform} {kind} {points}. */
  titleTemplate: string;
  style: EventStyle;
  /** Popup reminders, in minutes before the event starts. */
  reminders: number[];
  /** Submitted work: drop it, keep it with a check mark, or keep it as is. */
  submitted: "hide" | "check" | "keep";
  /** Skip tasks that were due more than this many days ago. */
  pastDays: number;
  /** IANA time zone used for all-day dates, e.g. "America/Los_Angeles". */
  timeZone: string;
  courses: Record<string, CourseSettings>;
  kinds: Partial<Record<AssignmentKind, KindSettings>>;
  statusColors: StatusColors;
  /** Pins a platform course ("canvas:1234") to a course label when names don't line up. */
  courseAliases: Record<string, string>;
  /** Courses the student said are the same class, by course key: {"me106a": "eecs106a"}. */
  courseMerges: Record<string, string>;
  platformPriority: Platform[];
  /** When sites disagree on a deadline and you pick "Not now", ask again after this many hours. */
  dueReminderHours: number;
}

export function defaultSettings(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Settings {
  return {
    calendars: "single",
    titleTemplate: "{course} · {title}",
    style: { type: "deadline", minutes: 30 },
    reminders: [24 * 60, 120],
    submitted: "check",
    pastDays: 7,
    timeZone,
    courses: {},
    kinds: {},
    statusColors: { dueSoonHours: 24 },
    courseAliases: {},
    courseMerges: {},
    platformPriority: [...DEFAULT_PLATFORM_PRIORITY],
    dueReminderHours: 24,
  };
}

/**
 * Colors given to courses automatically, in order. Tomato and Graphite are
 * left out: they read as "due soon" and "done".
 */
export const COURSE_PALETTE: EventColor[] = ["7", "6", "2", "3", "5", "9", "4", "10", "1"];

/**
 * Gives each of these courses that has no color one that none of the others
 * is using; with more courses than colors, they're reused in order. Courses
 * not listed (say, from earlier semesters) don't count, so they never crowd
 * out this term's classes. Returns null when nothing changed.
 */
export function assignCourseColors(settings: Settings, courseKeys: string[]): Settings | null {
  const courses = { ...settings.courses };
  const keys = [...new Set(courseKeys)].sort();
  let changed = false;
  keys.forEach((key, index) => {
    if (courses[key]?.color !== undefined) return;
    const taken = new Set(keys.map((k) => courses[k]?.color));
    const color = COURSE_PALETTE.find((c) => !taken.has(c)) ?? COURSE_PALETTE[index % COURSE_PALETTE.length]!;
    courses[key] = { ...courses[key], color };
    changed = true;
  });
  return changed ? { ...settings, courses } : null;
}

/** Whether event titles include the class name. */
export const titleHasCourse = (template: string) => template.includes("{course}");

/** The title template without the class name: "{course} · {title}" -> "{title}". */
export function dropCourseFromTitle(template: string): string {
  const out = template
    .replace(/^\s*\{course\}\s*[·|:\-–—]?\s*/, "") // "{course} · {title}"
    .replace(/\s*[·|:\-–—]?\s*\{course\}\s*$/, "") // "{title} - {course}"
    .replace(/\{course\}/g, "") // anywhere else
    .replace(/\(\s*\)|\[\s*\]/g, "") // brackets it leaves empty
    .replace(/\s+/g, " ")
    .trim();
  return out || "{title}";
}

/** The title template with the class name in front, if it isn't there already. */
export const addCourseToTitle = (template: string) => (titleHasCourse(template) ? template : `{course} · ${template}`);

/**
 * Switches the calendar layout. With one calendar per class, the calendar
 * already says which class an event is for, so the class name comes out of
 * titles; on a shared calendar it goes back in.
 */
export function switchCalendars(settings: Settings, calendars: Settings["calendars"]): Settings {
  const titleTemplate =
    calendars === "perCourse" ? dropCourseFromTitle(settings.titleTemplate) : addCourseToTitle(settings.titleTemplate);
  return { ...settings, calendars, titleTemplate };
}
