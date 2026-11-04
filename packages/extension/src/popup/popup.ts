import { PLATFORM_NAMES, type EventStyle, type Platform, type Settings } from "@backpack/core";
import type { Reply, Request } from "../background.js";
import { isGoogleConnected } from "../google/auth.js";
import { platformInfo } from "../platforms.js";
import { chromeStore, type State } from "../state.js";
import { missingWebsites, normalizeWebsiteUrl, showWebsiteBadge, type CourseWebsite } from "../websites.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const STYLES: Record<EventStyle["type"], EventStyle> = {
  deadline: { type: "deadline", minutes: 30 },
  allDay: { type: "allDay" },
  workBlock: { type: "workBlock", minutes: 120, hoursBefore: 24 },
};

function send(request: Request): Promise<Reply> {
  return chrome.runtime.sendMessage(request);
}

function say(text: string, tone: "ok" | "error" | "" = "") {
  const el = $("message");
  el.textContent = text;
  el.dataset.tone = tone;
}

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes} min ago`;
  return `Synced ${Math.round(minutes / 60)} h ago`;
}

/** "https://bcourses.berkeley.edu/courses/1" -> "bcourses.berkeley.edu". */
function cleanHost(input: string): string {
  return input.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
}

const checkboxes = () => [...document.querySelectorAll<HTMLInputElement>("input[data-platform]")];

/** What to show beside a checked platform: ready, or what still needs doing. */
async function platformStatus(state: State, platform: Platform): Promise<{ text: string; ok?: boolean }> {
  const info = platformInfo(platform);
  const origins = info.origins(state);
  if (!origins) return { text: "Add your address" };
  if (!(await chrome.permissions.contains({ origins }))) return { text: "Needs permission", ok: false };
  if (state.errors[platform]) return { text: "Needs attention", ok: false };
  const count = state.cache[platform]?.assignments.length;
  return count === undefined ? { text: "Ready", ok: true } : { text: `${count} assignments`, ok: true };
}

async function render() {
  const state = await chromeStore.load();
  const google = await isGoogleConnected();
  $("google-state").textContent = google ? "Connected" : "Not connected";
  if (google) $("google-state").dataset.ok = "true";
  else delete $("google-state").dataset.ok;
  $("connect-google").hidden = google;

  for (const box of checkboxes()) {
    const platform = box.dataset.platform as Platform;
    const on = state.platforms.includes(platform);
    box.checked = on;
    const label = document.querySelector<HTMLElement>(`[data-state="${platform}"]`);
    if (!label) continue;
    const status = on ? await platformStatus(state, platform) : { text: "" };
    label.textContent = status.text;
    if (status.ok === undefined) delete label.dataset.ok;
    else label.dataset.ok = String(status.ok);
  }
  $("canvas-setup").hidden = !state.platforms.includes("canvas");
  $<HTMLInputElement>("canvas-host").value = state.canvasHost ?? "";

  const { settings } = state;
  $<HTMLSelectElement>("calendars").value = settings.calendars;
  $<HTMLSelectElement>("style").value = settings.style.type;
  $<HTMLSelectElement>("submitted").value = settings.submitted;
  $<HTMLInputElement>("title-template").value = settings.titleTemplate;

  $("last-sync").textContent = state.lastSync ? ago(state.lastSync.at) : "";
  renderWebsites(state);
  showErrors(state);
}

/** Creates an element with an optional class and text. */
function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

const WEBSITE_ORDER: Record<CourseWebsite["status"], number> = { missing: 0, found: 1, manual: 1, none: 2 };

/** "https://www.cs61a.org/" -> "cs61a.org". */
const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

/** Shows the Course websites section once bCourses is set up. */
function renderWebsites(state: State) {
  const show = state.platforms.includes("canvas") && Boolean(state.canvasHost);
  $("websites-section").hidden = !show;
  if (!show) return;

  const entries = Object.entries(state.courseWebsites).sort(
    ([, a], [, b]) => WEBSITE_ORDER[a.status] - WEBSITE_ORDER[b.status] || a.label.localeCompare(b.label),
  );
  const missing = missingWebsites(state).length;
  $("websites-summary").textContent = !state.websitesCheckedAt && !entries.length
    ? "Backpack looks on bCourses for each course's website."
    : !entries.length
      ? "No current courses found on bCourses."
      : missing
        ? `Couldn't find a website for ${missing} course${missing === 1 ? "" : "s"} on bCourses. Add ${missing === 1 ? "it" : "them"} below, or mark a course as having none.`
        : "Found on bCourses. Reading assignments from course websites is coming soon.";
  $("websites").replaceChildren(...entries.map(([id, website]) => websiteRow(id, website)));
}

function websiteRow(id: string, website: CourseWebsite, editing = false): HTMLLIElement {
  const li = make("li");
  if (website.status === "missing") li.dataset.missing = "true";
  const top = make("div", "top");
  const name = make("span", "name", website.label);
  name.title = website.name;
  top.append(name);
  li.append(top);

  if (website.url && !editing) {
    const link = make("a", "site", shortUrl(website.url));
    link.href = website.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.title = website.url;
    const change = make("button", "mini", "Change");
    change.type = "button";
    change.addEventListener("click", () => li.replaceWith(websiteRow(id, website, true)));
    top.append(link, change);
    li.append(make("span", "muted hint", website.status === "manual" ? "Added by you" : `Found in ${website.foundIn ?? "bCourses"}`));
    return li;
  }

  if (website.status === "none" && !editing) {
    const add = make("button", "mini", "Add");
    add.type = "button";
    add.addEventListener("click", () => li.replaceWith(websiteRow(id, website, true)));
    top.append(make("span", "note", "No website"), add);
    return li;
  }

  if (website.status === "missing") top.append(make("span", "note", "Not found on bCourses"));
  const row = make("div", "row");
  const input = make("input");
  input.type = "text";
  input.inputMode = "url";
  input.spellcheck = false;
  input.placeholder = "https://…";
  input.value = website.url ?? "";
  input.setAttribute("aria-label", `${website.label} website`);
  const save = make("button", "mini", "Save");
  save.type = "button";
  save.addEventListener("click", () => void saveWebsite(id, input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void saveWebsite(id, input.value);
  });
  row.append(input, save);
  li.append(row);

  // Any course can be marked as having no website, including one where
  // Backpack found the wrong site.
  const actions = make("div", "actions");
  if (website.status !== "none") {
    const none = make("button", "link", "This course has no website");
    none.type = "button";
    none.addEventListener("click", () => void markNoWebsite(id));
    actions.append(none);
  }
  if (website.status !== "missing") {
    const cancel = make("button", "link", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => li.replaceWith(websiteRow(id, website)));
    actions.append(cancel);
  }
  li.append(actions);
  if (editing) queueMicrotask(() => input.focus());
  return li;
}

async function updateWebsite(id: string, patch: Pick<CourseWebsite, "url" | "status">) {
  const state = await chromeStore.load();
  const previous = state.courseWebsites[id];
  if (!previous) return null;
  // "Found in" no longer applies once the student sets it.
  const updated: CourseWebsite = { label: previous.label, name: previous.name, ...patch, checkedAt: Date.now() };
  const courseWebsites = { ...state.courseWebsites, [id]: updated };
  await chromeStore.save({ courseWebsites });
  await showWebsiteBadge({ ...state, courseWebsites });
  return updated;
}

async function saveWebsite(id: string, input: string) {
  const url = normalizeWebsiteUrl(input);
  if (!url) {
    say("Enter the course website's address, like cs61a.org.", "error");
    return;
  }
  const updated = await updateWebsite(id, { url, status: "manual" });
  if (updated) say(`Saved the ${updated.label} website.`, "ok");
  await render();
}

async function markNoWebsite(id: string) {
  const updated = await updateWebsite(id, { url: null, status: "none" });
  if (updated) say(`Marked ${updated.label} as having no website.`, "ok");
  await render();
}

async function findWebsites() {
  const button = $<HTMLButtonElement>("find-websites");
  button.disabled = true;
  say("Looking for course websites on bCourses…");
  const reply = await send({ type: "findWebsites" });
  button.disabled = false;
  const state = await chromeStore.load();
  if (!reply.ok) {
    say(reply.error, "error");
  } else {
    const all = Object.values(state.courseWebsites);
    const found = all.filter((w) => w.url).length;
    say(`Websites for ${found} of ${all.length} course${all.length === 1 ? "" : "s"}.`, found === all.length ? "ok" : "");
  }
  await render();
}

function showErrors(state: State) {
  const problems = Object.entries(state.errors)
    .filter(([where]) => where === "google" || state.platforms.includes(where as Platform))
    .map(([where, text]) => `${where === "google" ? "Google" : PLATFORM_NAMES[where as Platform]}: ${text}`);
  if (problems.length) say(problems.join(" "), "error");
}

/** Checking a platform asks Chrome for permission to read its site, then turns it on. */
async function setPlatform(platform: Platform, on: boolean) {
  const state = await chromeStore.load();
  const info = platformInfo(platform);
  // Canvas needs the school's address first; its Allow button asks for permission then.
  const origins = info.origins(state);
  if (on && origins && !(await chrome.permissions.request({ origins }))) {
    say(`Backpack needs permission to read ${info.label}.`, "error");
    await render();
    return;
  }
  const platforms = on ? [...new Set([...state.platforms, platform])] : state.platforms.filter((p) => p !== platform);
  await chromeStore.save({ platforms });
  if (!on) say(`${info.label} removed. Its events go away on the next sync.`, "ok");
  else if (origins) say(`${info.label} added. Sync to pull in its assignments.`, "ok");
  else say("Enter your Canvas address below.");
  await render();
}

for (const box of checkboxes()) {
  box.addEventListener("change", () => void setPlatform(box.dataset.platform as Platform, box.checked));
}

async function saveSettings(patch: Partial<Settings>) {
  const { settings } = await chromeStore.load();
  await chromeStore.save({ settings: { ...settings, ...patch } });
  say("Saved. Sync to apply.");
}

$("connect-google").addEventListener("click", async () => {
  say("Opening Google sign-in…");
  const reply = await send({ type: "connectGoogle" });
  say(reply.ok ? "Google Calendar connected." : reply.error, reply.ok ? "ok" : "error");
  await render();
});

$("save-canvas").addEventListener("click", async () => {
  const host = cleanHost($<HTMLInputElement>("canvas-host").value);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    say("Enter your Canvas address, like bcourses.berkeley.edu.", "error");
    return;
  }
  // Chrome asks the user to allow Backpack to read this one site.
  const granted = await chrome.permissions.request({ origins: [`https://${host}/*`] });
  if (!granted) {
    say("Backpack needs permission to read your Canvas assignments.", "error");
    return;
  }
  const { platforms } = await chromeStore.load();
  await chromeStore.save({ canvasHost: host, platforms: [...new Set([...platforms, "canvas" as const])] });
  say(`Canvas set to ${host}.`, "ok");
  await render();
  await findWebsites();
});

$("find-websites").addEventListener("click", () => void findWebsites());

$("calendars").addEventListener("change", (e) =>
  saveSettings({ calendars: (e.target as HTMLSelectElement).value as Settings["calendars"] }),
);
$("style").addEventListener("change", (e) =>
  saveSettings({ style: STYLES[(e.target as HTMLSelectElement).value as EventStyle["type"]] }),
);
$("submitted").addEventListener("change", (e) =>
  saveSettings({ submitted: (e.target as HTMLSelectElement).value as Settings["submitted"] }),
);
$("title-template").addEventListener("change", (e) => {
  const value = (e.target as HTMLInputElement).value.trim();
  if (value) void saveSettings({ titleTemplate: value });
});

$("sync").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("sync");
  button.disabled = true;
  say("Syncing…");
  const reply = await send({ type: "sync" });
  button.disabled = false;
  const state = await chromeStore.load();
  if (reply.ok && state.lastSync) {
    const { created, updated, removed, tasks } = state.lastSync;
    say(`${tasks} assignments on your calendar. ${created} added, ${updated} updated, ${removed} removed.`, "ok");
  } else if (!reply.ok) {
    say(reply.error, "error");
  }
  await render();
  if (reply.ok && Object.keys(state.errors).length) showErrors(state);
});

void render().then(async () => {
  // First time with bCourses set up: look for course websites right away.
  const state = await chromeStore.load();
  if (!$("websites-section").hidden && !state.websitesCheckedAt && !Object.keys(state.courseWebsites).length) {
    await findWebsites();
  }
});
