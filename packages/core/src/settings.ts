import { DEFAULT_PLATFORM_PRIORITY } from "./merge.js";
import type { Platform } from "./types.js";

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
  color?: EventColor;
  hidden?: boolean;
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
  /** Pins a platform course ("canvas:1234") to a course label when names don't line up. */
  courseAliases: Record<string, string>;
  platformPriority: Platform[];
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
    courseAliases: {},
    platformPriority: [...DEFAULT_PLATFORM_PRIORITY],
  };
}
