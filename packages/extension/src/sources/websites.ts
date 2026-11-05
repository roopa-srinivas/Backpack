import { identifyCourse, type Course } from "@backpack/core";
import { HTMLElement, NodeType, parse, type Node } from "node-html-parser";
import type { State, Store } from "../state.js";
import type { CourseWebsite } from "../websites.js";
import { CanvasError, canvasApi, fetchCanvasCourses, toCourse, type CanvasApi } from "./canvas.js";

/**
 * Finds each bCourses course's own website. Course staff link it from a
 * navigation tab (often a "Course Website" redirect tool), the Home page, the
 * Syllabus, Modules, or an announcement, so Backpack reads those and keeps
 * the link most likely to be the course's site.
 */

export type WhereFound = "Navigation tab" | "Home page" | "Syllabus" | "Modules" | "Announcements";

/** A link that might be the course website, with the words around it. */
export interface Candidate {
  url: string;
  context: string;
  where: WhereFound;
}

/**
 * Look again for a course's missing website after this long. Staff usually
 * post the link in the first week or two of term, so weekly catches a late
 * link without reading bCourses over and over.
 */
export const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

// Announcements come last: they link to the most other things.
const WHERE_ORDER: WhereFound[] = ["Navigation tab", "Home page", "Syllabus", "Modules", "Announcements"];

const WEBSITE_WORDS = /\b(course|class)[\s-]*(web[\s-]*)?(site|page|homepage)\b|\bwebsite\b|\bhome[\s-]*page\b/i;

/** Sites that are linked from courses but are never the course's own website. */
const NOT_WEBSITES = [
  "gradescope.com",
  "prairielearn.com",
  "prairielearn.org",
  "piazza.com",
  "edstem.org",
  "campuswire.com",
  "zoom.us",
  "youtube.com",
  "youtu.be",
  "docs.google.com",
  "drive.google.com",
  "forms.google.com",
  "calendar.google.com",
  "meet.google.com",
  "forms.gle",
  "goo.gl",
  "bit.ly",
  "tinyurl.com",
  "instructure.com",
  "canvaslms.com",
  "edu-apps.org",
  "slack.com",
  "discord.gg",
  "discord.com",
  "calendly.com",
];

/** Subdomains of a course site that are a tool, not the site, e.g. oh.cs61a.org. */
const TOOL_SUBDOMAINS = new Set(["oh", "ohq", "queue", "status", "code", "okpy", "autograder", "submit", "piazza", "ed"]);

const FILE_LINK = /\.(pdf|png|jpe?g|gif|svg|zip|ipynb|docx?|pptx?|xlsx?|mp4|mov|txt)$/i;

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Whether this host is `domain` or one of its subdomains. */
const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function absolute(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Links in a page of course content (Syllabus, Home page). Each comes with
 * its link text and, when it's short, the sentence it sits in, so
 * "Course website: cs61a.org" counts even when only "cs61a.org" is linked.
 */
export function linksInHtml(html: string | null | undefined, where: WhereFound): Candidate[] {
  if (!html) return [];
  const root = parse(html);
  const candidates: Candidate[] = [];
  const linked = new Set<string>();

  for (const anchor of root.querySelectorAll("a[href]")) {
    const url = absolute(anchor.getAttribute("href"));
    if (!url) continue;
    linked.add(url);
    const block = enclosingBlock(anchor);
    const blockText = block ? squash(block.text) : "";
    const context = blockText.length <= 200 ? blockText || squash(anchor.text) : squash(anchor.text);
    candidates.push({ url, context: `${squash(anchor.text)} ${context}`.trim(), where });
  }

  // Addresses typed out without a link. Each piece of text is read on its own
  // so words from a neighboring paragraph don't count as this address's context.
  for (const text of textNodes(root)) {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
      const url = absolute(match[0].replace(/[.,;:]+$/, ""));
      if (!url || linked.has(url)) continue;
      const before = text.slice(Math.max(0, match.index - 60), match.index);
      candidates.push({ url, context: squash(`${before} ${match[0]}`), where });
    }
  }
  return candidates;
}

/** The text of every text node outside links. */
function textNodes(node: Node): string[] {
  if (node.nodeType === NodeType.TEXT_NODE) return [node.text];
  if (node instanceof HTMLElement && node.rawTagName?.toLowerCase() === "a") return [];
  return node.childNodes.flatMap(textNodes);
}

function enclosingBlock(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentNode; node; node = node.parentNode) {
    if (/^(p|li|td|th|dd|dt|h[1-6]|div|section|blockquote)$/i.test(node.rawTagName ?? "")) return node;
  }
  return null;
}

/** The claims of a JWT, read without checking its signature (only used to find a link). */
function jwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Where a navigation tab's tool launch sends the student. A Redirect Tool tab
 * renders a form whose hidden fields carry the destination (custom_url for
 * LTI 1.1; the custom claim inside id_token for LTI 1.3).
 */
export function launchTargets(html: string): string[] {
  const root = parse(html);
  const urls: string[] = [];
  for (const input of root.querySelectorAll("form input[name]")) {
    const name = input.getAttribute("name") ?? "";
    const value = input.getAttribute("value") ?? "";
    if (/^(custom_)?(url|redirect_url|target_url|link|website)$/i.test(name)) {
      const url = absolute(value);
      if (url) urls.push(url);
    } else if (/^(id_token|jwt)$/i.test(name)) {
      const custom = jwtClaims(value)?.["https://purl.imsglobal.org/spec/lti/claim/custom"];
      for (const v of Object.values((custom ?? {}) as Record<string, unknown>)) {
        const url = typeof v === "string" ? absolute(v) : null;
        if (url) urls.push(url);
      }
    }
  }
  return urls;
}

function courseCode(course: Course): { key: string; number: string } | null {
  const { key } = identifyCourse(course);
  const match = /^([a-z]+)(\d+[a-z]*)$/.exec(key);
  return match ? { key, number: match[2]! } : null;
}

/** How likely a link is to be this course's website; below 3 it's not counted. */
export function scoreCandidate(candidate: Candidate, course: Course, canvasHost: string): number {
  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch {
    return 0;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (onDomain(host, canvasHost) || NOT_WEBSITES.some((d) => onDomain(host, d))) return 0;
  if (FILE_LINK.test(url.pathname)) return 0;

  let score = 0;
  if (WEBSITE_WORDS.test(candidate.context)) score += 3;

  const code = courseCode(course);
  if (code) {
    const squashedHost = host.replace(/[^a-z0-9]/g, "");
    const squashedPath = url.pathname.toLowerCase().replace(/[^a-z0-9]/g, "");
    const segments = url.pathname.split("/").filter(Boolean).length;
    if (squashedHost.includes(code.key) || new RegExp(`[a-z]${code.number}(?![0-9a-z])`).test(host)) score += 3;
    else if (squashedPath.includes(code.key)) score += segments <= 3 ? 2 : 1;
  }

  if (onDomain(host, "berkeley.edu") || onDomain(host, "github.io")) score += 1;
  if (candidate.where === "Navigation tab") score += 1;
  if (TOOL_SUBDOMAINS.has(host.split(".")[0]!)) score -= 2;
  return score;
}

/** The candidate most likely to be the course website, or null when none is convincing. */
export function pickWebsite(candidates: Candidate[], course: Course, canvasHost: string): Candidate | null {
  let best: { candidate: Candidate; score: number } | null = null;
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, course, canvasHost);
    if (score < 3) continue;
    const better =
      !best ||
      score > best.score ||
      (score === best.score &&
        (WHERE_ORDER.indexOf(candidate.where) < WHERE_ORDER.indexOf(best.candidate.where) ||
          (candidate.where === best.candidate.where && candidate.url.length < best.candidate.url.length)));
    if (better) best = { candidate, score };
  }
  return best?.candidate ?? null;
}

interface CanvasTab {
  id: string;
  label: string;
  type: "internal" | "external";
  html_url: string;
  hidden?: boolean;
}

interface CanvasAnnouncement {
  title: string;
  message?: string | null;
}

/**
 * Links in announcements. An announcement titled like "Course website is up"
 * that links one site gives that link its title as context too; with several
 * links, the title can't say which one it means.
 */
export function linksInAnnouncements(announcements: CanvasAnnouncement[]): Candidate[] {
  return announcements.flatMap((announcement) => {
    const links = linksInHtml(announcement.message, "Announcements");
    const sites = new Set(links.map((l) => new URL(l.url).hostname));
    if (sites.size !== 1) return links;
    return links.map((l) => ({ ...l, context: `${squash(announcement.title)} ${l.context}` }));
  });
}

interface CanvasModule {
  items?: { type: string; title: string; external_url?: string }[];
}

/**
 * Reads the places on bCourses a course links its website from. Undefined
 * when Backpack couldn't finish reading (e.g. the network dropped), so a
 * failed read isn't mistaken for "this course has no website".
 */
export async function findCourseWebsite(
  api: CanvasApi,
  course: Course,
): Promise<{ url: string; where: WhereFound } | null | undefined> {
  let incomplete = false;
  // Students can't see every part of every course; a part they can't see has no links.
  const read = async <T>(load: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await load();
    } catch (error) {
      if (!(error instanceof CanvasError)) incomplete = true;
      return fallback;
    }
  };

  const id = course.id;
  const [tabs, details, frontPage, modules, announcements] = await Promise.all([
    read(() => api.getAll<CanvasTab>(`/api/v1/courses/${id}/tabs`), []),
    read(() => api.get<{ syllabus_body?: string | null }>(`/api/v1/courses/${id}?include[]=syllabus_body`), {}),
    read(() => api.get<{ body?: string | null }>(`/api/v1/courses/${id}/front_page`), {}),
    read(() => api.getAll<CanvasModule>(`/api/v1/courses/${id}/modules?include[]=items&per_page=100`), []),
    // The course's own announcement list has no date limit, unlike /api/v1/announcements (last 14 days).
    read(
      () => api.getAll<CanvasAnnouncement>(`/api/v1/courses/${id}/discussion_topics?only_announcements=true&per_page=100`),
      [],
    ),
  ]);

  const candidates: Candidate[] = [];
  const websiteTabs = tabs.filter((t) => t.type === "external" && !t.hidden && WEBSITE_WORDS.test(t.label)).slice(0, 2);
  for (const tab of websiteTabs) {
    const link = new URL(tab.html_url, `https://${api.host}`);
    const path = link.pathname + link.search;
    const html = await read(() => api.getPage(path), "");
    candidates.push(...launchTargets(html).map((url) => ({ url, context: tab.label, where: "Navigation tab" as const })));
  }
  candidates.push(...linksInHtml(frontPage.body, "Home page"));
  candidates.push(...linksInHtml(details.syllabus_body, "Syllabus"));
  for (const item of modules.flatMap((m) => m.items ?? [])) {
    const url = item.type === "ExternalUrl" ? absolute(item.external_url) : null;
    if (url) candidates.push({ url, context: item.title, where: "Modules" });
  }
  candidates.push(...linksInAnnouncements(announcements));

  const best = pickWebsite(candidates, course, api.host);
  if (best) return { url: best.url, where: best.where };
  return incomplete ? undefined : null;
}

/** Websites the student filled in (or said there isn't one) are never overwritten. */
const setByStudent = (w: CourseWebsite | undefined) => w?.status === "manual" || w?.status === "none";

/**
 * Looks through bCourses for course websites and saves what it finds. New
 * courses are looked at right away. Without `force`, a course with no website
 * is looked at again once a week, and a found website is kept as is.
 */
export async function refreshCourseWebsites(
  store: Store,
  host: string,
  { force = false, now = Date.now(), fetchImpl = fetch as typeof fetch } = {},
): Promise<void> {
  const state: State = await store.load();
  const api = canvasApi(host, fetchImpl);
  const courses = await fetchCanvasCourses(api);
  const websites: Record<string, CourseWebsite> = {};
  let incomplete = false;

  // One course at a time, to go easy on bCourses.
  for (const canvasCourse of courses) {
    const course = toCourse(canvasCourse);
    const previous = state.courseWebsites[course.id];
    const identity = identifyCourse(course, state.settings.courseAliases);
    const names = { label: state.settings.courses[identity.key]?.label ?? identity.label, name: course.name };

    const lookAgain =
      !setByStudent(previous) &&
      (!previous || force || (previous.status === "missing" && now - previous.checkedAt >= RECHECK_MS));
    if (previous && !lookAgain) {
      websites[course.id] = { ...previous, ...names };
      continue;
    }
    const found = await findCourseWebsite(api, course);
    if (found === undefined) {
      incomplete = true;
      if (previous) websites[course.id] = previous;
      continue;
    }
    websites[course.id] = found
      ? { ...names, url: found.url, status: "found", foundIn: found.where, checkedAt: now }
      : { ...names, url: null, status: "missing", checkedAt: now };
  }

  // Keep anything the student set in the menu while this was running.
  const latest = (await store.load()).courseWebsites;
  for (const [id, website] of Object.entries(latest)) {
    if (id in websites && setByStudent(website)) websites[id] = website;
  }
  await store.save({ courseWebsites: websites, ...(incomplete ? {} : { websitesCheckedAt: now }) });
}
