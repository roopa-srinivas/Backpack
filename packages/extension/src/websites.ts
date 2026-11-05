import { isEarlierTerm, parseTerm } from "@backpack/core";
import type { State } from "./state.js";

/**
 * What Backpack knows about one bCourses course's website. Finding them lives
 * in sources/websites.ts (background only); this file is small enough for the menu.
 */
export interface CourseWebsite {
  /** Short course label, e.g. "CS 169A". */
  label: string;
  /** Full bCourses name, e.g. "COMPSCI 169A - LEC 001". */
  name: string;
  url: string | null;
  /**
   * found: read from bCourses. manual: the student typed it in.
   * none: the student said the course has no website. missing: not found yet.
   */
  status: "found" | "manual" | "none" | "missing";
  /** Where on bCourses it was found, e.g. "Syllabus". */
  foundIn?: string;
  /** The course's term, e.g. "Fall 2026", when bCourses says. */
  term?: string;
  checkedAt: number;
}

/** True for a course from a semester before this one. */
export const isEarlierCourse = (website: CourseWebsite, now = Date.now()) => isEarlierTerm(parseTerm(website.term), now);

/**
 * This semester's courses whose website Backpack couldn't find and the
 * student hasn't filled in. Earlier semesters' courses never need attention.
 */
export function missingWebsites(state: State, now = Date.now()): CourseWebsite[] {
  if (!state.platforms.includes("canvas")) return [];
  return Object.values(state.courseWebsites).filter((w) => w.status === "missing" && !isEarlierCourse(w, now));
}

/**
 * Cleans up a typed-in website: "cs61a.org" -> "https://cs61a.org/".
 * Null when it isn't a web address.
 */
export function normalizeWebsiteUrl(input: string): string | null {
  let text = input.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!/\.[a-z]{2,}$/i.test(url.hostname)) return null;
  return url.href;
}

/** A count on the toolbar icon while some course is missing its website. */
export async function showWebsiteBadge(state: State): Promise<void> {
  const missing = missingWebsites(state).length;
  await chrome.action.setBadgeText({ text: missing ? String(missing) : "" });
  if (!missing) {
    await chrome.action.setTitle({ title: "Backpack" });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#E0A458" });
  await chrome.action.setBadgeTextColor({ color: "#241505" });
  await chrome.action.setTitle({
    title: `Backpack: ${missing} course${missing === 1 ? "" : "s"} need${missing === 1 ? "s" : ""} a website`,
  });
}
