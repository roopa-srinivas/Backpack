import { PLATFORM_NAMES, type EventStyle, type Platform, type Settings } from "@backpack/core";
import type { Reply, Request } from "../background.js";
import { isGoogleConnected } from "../google/auth.js";
import { platformInfo } from "../platforms.js";
import { chromeStore, type State } from "../state.js";

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
  showErrors(state);
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
});

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

void render();
