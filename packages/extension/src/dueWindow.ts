import { dueReminders, isOpen, REMIND_EARLY_MS, unshown, type DueQuestion } from "@backpack/core";
import { chromeStore } from "./state.js";

/** Google Calendar in the browser: opening it is when "remind me" reminders show. */
export const CALENDAR_ORIGINS = ["https://calendar.google.com/*"];

/**
 * The open due-date window: which questions it shows (null for every open
 * one) and when they were shown, so closing it can tell what went unanswered.
 */
export interface DueWindow {
  id: number;
  keys: string[] | null;
  shownAt: number;
}

export async function openDueWindow(): Promise<DueWindow | null> {
  const { dueWindow } = (await chrome.storage.session.get("dueWindow")) as { dueWindow?: DueWindow };
  return dueWindow ?? null;
}

/**
 * Shows the due-date window for some questions, or every open one. A window
 * already open takes the new questions too and comes to the front.
 */
export async function showDueDates(keys: string[] | null): Promise<void> {
  // Shown questions are marked, so no sync (on this computer or another) pops them up again.
  const { dueQuestions } = await chromeStore.load();
  const now = Date.now();
  const marked = Object.fromEntries(
    Object.entries(dueQuestions).map(([k, q]) => [k, !q.shownAt && (!keys || keys.includes(k)) ? { ...q, shownAt: now } : q]),
  );
  await chromeStore.save({ dueQuestions: marked });

  const current = await openDueWindow();
  if (current) {
    const merged = current.keys && keys ? [...new Set([...current.keys, ...keys])] : null;
    try {
      await chrome.windows.update(current.id, { focused: true, drawAttention: true });
      await chrome.storage.session.set({ dueWindow: { ...current, keys: merged } });
      return;
    } catch {
      // Closed without Chrome telling us: open a new one.
    }
  }
  // Noted before the window opens, so the page knows which questions to show as it loads.
  const shown: DueWindow = { id: -1, keys, shownAt: Date.now() };
  await chrome.storage.session.set({ dueWindow: shown });
  const win = await chrome.windows.create({ url: "dates.html", type: "popup", width: 460, height: 640, focused: true });
  if (win?.id === undefined) return;
  await chrome.storage.session.set({ dueWindow: { ...shown, id: win.id } });
}

/**
 * Whether closing the window should count as "Not now" for a question: it
 * was waiting for an answer (new, or its reminder time had come) and got
 * none while the window was open.
 */
function unanswered(q: DueQuestion, shownAt: number, now: number): boolean {
  if ((q.answeredAt ?? 0) >= shownAt) return false;
  return q.answer.kind === "unanswered" || (q.answer.kind === "later" && now >= q.answer.remindAt - REMIND_EARLY_MS);
}

/** Closing the window without answering is "Not now": Backpack asks again after the usual wait. */
export async function dueWindowClosed(id: number, now = Date.now()): Promise<void> {
  const current = await openDueWindow();
  if (current?.id !== id) return;
  await chrome.storage.session.remove("dueWindow");
  const { dueQuestions, settings } = await chromeStore.load();
  const shown = current.keys ?? Object.keys(dueQuestions).filter((k) => isOpen(dueQuestions[k]!));
  const remindAt = now + settings.dueReminderHours * 3_600_000;
  const questions = { ...dueQuestions };
  let changed = false;
  for (const key of shown) {
    const q = questions[key];
    if (!q || !unanswered(q, current.shownAt, now)) continue;
    questions[key] = { ...q, answer: { kind: "later", remindAt }, answeredAt: now };
    changed = true;
  }
  if (changed) await chromeStore.save({ dueQuestions: questions });
}

/**
 * After a sync, even one that failed partway: asks about disagreements no one
 * has seen yet. Reminders you set wait for you to open Google Calendar,
 * unless you synced by hand or Backpack can't see when Google Calendar is open.
 */
export async function askAboutDueDates(byHand: boolean, now = Date.now()): Promise<void> {
  const { dueQuestions } = await chromeStore.load();
  const keys = unshown(dueQuestions);
  if (byHand || !(await chrome.permissions.contains({ origins: CALENDAR_ORIGINS }))) keys.push(...dueReminders(dueQuestions, now));
  if (keys.length) await showDueDates([...new Set(keys)]);
}

/** Opening Google Calendar shows the questions whose reminder time has come. */
export async function calendarOpened(now = Date.now()): Promise<void> {
  const keys = dueReminders((await chromeStore.load()).dueQuestions, now);
  if (keys.length) await showDueDates(keys);
}
