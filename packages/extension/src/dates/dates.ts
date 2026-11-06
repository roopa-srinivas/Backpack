import {
  formatDue,
  fromLocalInput,
  isOpen,
  PLATFORM_NAMES,
  REMIND_EARLY_MS,
  toLocalInput,
  type DueAnswer,
  type DueQuestion,
} from "@backpack/core";
import type { Reply, Request } from "../background.js";
import { CALENDAR_ORIGINS, openDueWindow } from "../dueWindow.js";
import { chromeStore, type State } from "../state.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const HOUR = 3_600_000;

function send(request: Request): Promise<Reply> {
  return chrome.runtime.sendMessage(request);
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

/** What's typed or picked in each card, kept across redraws. */
interface Draft {
  /** An option's index, or "custom". */
  choice: string;
  custom: string;
  picking: boolean;
  remindAt: string;
  error: string;
}
const drafts = new Map<string, Draft>();

/** Questions in this window, in order. They stay listed once answered, to show what was saved. */
const listed: string[] = [];
/** Answers given in this window. */
const answeredHere = new Map<string, DueQuestion>();
/** Whether Backpack can see when Google Calendar is open, for reminders. */
let seesCalendar = false;

async function answer(key: string, value: DueAnswer) {
  const { dueQuestions } = await chromeStore.load();
  const question = dueQuestions[key];
  if (question) {
    const updated = { ...question, answer: value, answeredAt: Date.now() };
    await chromeStore.save({ dueQuestions: { ...dueQuestions, [key]: updated } });
    answeredHere.set(key, updated);
    // A new date goes on the calendar now; the other answers leave it as it is.
    if (value.kind === "date") void send({ type: "sync" });
  }
  await render();
}

/** Reminders show when you open Google Calendar, which Backpack needs permission to notice. */
async function letBackpackSeeCalendar() {
  try {
    seesCalendar = await chrome.permissions.request({ origins: CALENDAR_ORIGINS });
  } catch {
    seesCalendar = false;
  }
}

function confirmation(q: DueQuestion, state: State): HTMLElement {
  const zone = state.settings.timeZone;
  const showing = state.lastDue[q.taskKey] ?? q.heldDueAt;
  const a = q.answer;
  const text =
    a.kind === "date"
      ? `Due date set to ${formatDue(Date.parse(a.dueAt), zone)}. Your calendar is updating.`
      : a.kind === "keep"
        ? `${showing ? `Keeping ${formatDue(Date.parse(showing), zone)}` : "Leaving your calendar as it is"}. Backpack won't ask about this again.`
        : a.kind === "later"
          ? `Backpack will remind you around ${formatDue(a.remindAt, zone)}, ${
              seesCalendar ? "the next time you open Google Calendar then" : "on its first sync after then"
            }.`
          : "";
  return make("p", "answered", `✓ ${text}`);
}

function card(key: string, index: number, state: State): HTMLElement {
  const article = make("article", "question");
  const q = answeredHere.get(key) ?? state.dueQuestions[key];
  if (!q) {
    article.append(make("p", "answered muted", "Your sites agree on this due date now. Nothing to do."));
    return article;
  }
  article.append(make("h2", "", `${q.courseLabel} · ${q.title}`));
  if (answeredHere.has(key) || !isOpen(q)) {
    article.append(confirmation(q, state));
    return article;
  }

  const zone = state.settings.timeZone;
  const fmt = (iso: string) => formatDue(Date.parse(iso), zone);
  const showing = state.lastDue[key] ?? q.heldDueAt;
  const draft = drafts.get(key) ?? {
    choice: "",
    custom: toLocalInput(Date.parse(showing ?? q.options[0]!.dueAt), zone),
    picking: false,
    remindAt: toLocalInput(Math.ceil((Date.now() + state.settings.dueReminderHours * HOUR) / HOUR) * HOUR, zone),
    error: "",
  };
  drafts.set(key, draft);

  if (showing) article.append(make("p", "note", `Your calendar shows ${fmt(showing)} until you choose.`));
  if (q.answer.kind === "later") {
    const due = Date.now() >= q.answer.remindAt - REMIND_EARLY_MS;
    article.append(
      make("p", "note reminder", due ? "You asked to be reminded about this." : `Backpack will remind you around ${formatDue(q.answer.remindAt, zone)}.`),
    );
  }

  const choices = make("fieldset", "choices");
  choices.append(make("legend", "", "Which due date is right?"));
  const radio = (value: string) => {
    const input = make("input");
    input.type = "radio";
    input.name = `due-${index}`;
    input.value = value;
    input.checked = draft.choice === value;
    input.addEventListener("change", () => (draft.choice = value));
    return input;
  };
  q.options.forEach((option, i) => {
    const label = make("label", "choice");
    const where = option.platforms.map((p) => PLATFORM_NAMES[p]).join(" and ");
    label.append(radio(String(i)), make("span", "when", fmt(option.dueAt)), make("span", "where", where));
    choices.append(label);
  });
  const own = make("label", "choice");
  const customRadio = radio("custom");
  const custom = make("input");
  custom.type = "datetime-local";
  custom.value = draft.custom;
  custom.setAttribute("aria-label", "Another due date");
  custom.addEventListener("input", () => {
    draft.custom = custom.value;
    draft.choice = "custom";
    customRadio.checked = true;
  });
  own.append(customRadio, make("span", "where", "None of these:"), custom);
  choices.append(own);

  const error = make("p", "error", draft.error);
  const fail = (text: string) => {
    draft.error = text;
    error.textContent = text;
  };

  const use = make("button", "primary", "Use this date");
  use.type = "button";
  use.addEventListener("click", () => {
    if (!draft.choice) return fail("Choose one of the dates, or enter the right one.");
    if (draft.choice !== "custom") {
      return void answer(key, { kind: "date", dueAt: q.options[Number(draft.choice)]!.dueAt, custom: false });
    }
    const at = fromLocalInput(draft.custom, zone);
    if (at === null) return fail("Enter the due date and time.");
    void answer(key, { kind: "date", dueAt: new Date(at).toISOString(), custom: true });
  });

  const later = make("button", "", "Remind me later");
  const notNow = make("button", "", "Not now");
  const keep = make("button", "", "Don't change the due date");
  for (const b of [later, notNow, keep]) b.type = "button";
  later.setAttribute("aria-expanded", String(draft.picking));
  later.addEventListener("click", () => {
    draft.picking = !draft.picking;
    void render();
  });
  notNow.addEventListener("click", async () => {
    await letBackpackSeeCalendar();
    await answer(key, { kind: "later", remindAt: Date.now() + state.settings.dueReminderHours * HOUR });
  });
  keep.addEventListener("click", () => void answer(key, { kind: "keep" }));

  const actions = make("div", "actions");
  actions.append(later, notNow, keep);
  article.append(choices, error, use, actions);

  if (draft.picking) {
    const picker = make("div", "picker");
    const label = make("label", "", "Remind me at");
    const when = make("input");
    when.type = "datetime-local";
    when.id = `remind-${index}`;
    label.htmlFor = when.id;
    when.value = draft.remindAt;
    when.addEventListener("input", () => (draft.remindAt = when.value));
    const set = make("button", "small", "Remind me then");
    set.type = "button";
    set.addEventListener("click", async () => {
      const at = fromLocalInput(draft.remindAt, zone);
      if (at === null || at <= Date.now()) return fail("Pick a time that hasn't passed yet.");
      await letBackpackSeeCalendar();
      await answer(key, { kind: "later", remindAt: at });
    });
    const row = make("div", "row");
    row.append(when, set);
    picker.append(label, row, make("p", "muted hint", "Backpack asks again the next time you open Google Calendar around then."));
    article.append(picker);
  }
  return article;
}

async function render() {
  const [state, win] = await Promise.all([chromeStore.load(), openDueWindow()]);
  const open = Object.keys(state.dueQuestions).filter((k) => isOpen(state.dueQuestions[k]!));
  for (const key of win?.keys ?? open) if (!listed.includes(key)) listed.push(key);

  const main = $("questions");
  main.replaceChildren(...listed.map((key, i) => card(key, i, state)));
  if (!listed.length) main.append(make("p", "question muted", "Nothing to check right now: your sites agree on every due date."));
  const pending = listed.some((key) => !answeredHere.has(key) && state.dueQuestions[key] && isOpen(state.dueQuestions[key]!));
  $("done").hidden = pending;
}

$("close").addEventListener("click", () => window.close());

chrome.storage.onChanged.addListener((changes) => {
  if ("dueQuestions" in changes || "dueWindow" in changes) void render();
});

void chrome.permissions.contains({ origins: CALENDAR_ORIGINS }).then((yes) => {
  seesCalendar = yes;
  return render();
});
