import {
  assignCourseColors,
  colorHex,
  EVENT_COLORS,
  isEarlierTerm,
  isHexColor,
  nearestEventColor,
  switchCalendars,
  mergeAssignments,
  newestFirst,
  newestTerm,
  termName,
  type Term,
  type AssignmentKind,
  type EventColor,
  type HexColor,
  type Settings,
  type Task,
  textColorOn,
} from "@backpack/core";
import type { Reply, Request } from "../background.js";
import { chromeStore } from "../state.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const KINDS: { kind: AssignmentKind; label: string; emoji: string }[] = [
  { kind: "assignment", label: "Homework", emoji: "📝" },
  { kind: "project", label: "Projects", emoji: "🛠️" },
  { kind: "lab", label: "Labs", emoji: "🧪" },
  { kind: "quiz", label: "Quizzes", emoji: "❓" },
  { kind: "exam", label: "Exams", emoji: "🎯" },
  { kind: "discussion", label: "Discussions", emoji: "💬" },
  { kind: "other", label: "Other", emoji: "📌" },
];

const DAY = 24 * 60;
const REMINDERS: { label: string; minutes: number[] }[] = [
  { label: "None", minutes: [] },
  { label: "1 hour before", minutes: [60] },
  { label: "2 hours before", minutes: [120] },
  { label: "1 day before", minutes: [DAY] },
  { label: "1 day and 2 hours before", minutes: [DAY, 120] },
  { label: "2 days before", minutes: [2 * DAY] },
  { label: "3 days and 1 day before", minutes: [3 * DAY, DAY] },
  { label: "1 week and 1 day before", minutes: [7 * DAY, DAY] },
];

const DUE_SOON_HOURS = [6, 12, 24, 48, 72];

function send(request: Request): Promise<Reply> {
  return chrome.runtime.sendMessage(request);
}

function say(text: string, tone: "ok" | "error" | "" = "") {
  const el = $("message");
  el.textContent = text;
  el.dataset.tone = tone;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

/** Applies a change to the latest settings and saves them. */
async function update(change: (settings: Settings) => Settings) {
  const { settings } = await chromeStore.load();
  await chromeStore.save({ settings: change(settings) });
  say("Saved. Apply to calendar to see it there.");
  await render();
}

/**
 * A row of Google Calendar's colors, with an optional "no color" choice
 * first and, when `custom` is set, a color wheel for any color.
 */
function swatches(
  current: EventColor | HexColor | null | undefined,
  noneLabel: string | null,
  name: string,
  onPick: (color: EventColor | HexColor | null) => void,
  custom = false,
): HTMLElement {
  const group = make("div", "swatches");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", name);
  const option = (color: EventColor | null, label: string) => {
    const button = make("button", color ? "swatch" : "swatch none", color ? "" : label);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String((current ?? null) === color));
    button.title = label;
    if (color) {
      button.style.background = EVENT_COLORS[color].hex;
      button.setAttribute("aria-label", label);
    }
    button.addEventListener("click", () => onPick(color));
    group.append(button);
  };
  if (noneLabel) option(null, noneLabel);
  for (const [color, { name: colorName }] of Object.entries(EVENT_COLORS) as [EventColor, { name: string }][]) {
    option(color, colorName);
  }
  if (custom) {
    // Chrome's color picker: a color wheel, an eyedropper and hex input.
    const wheel = make("label", "swatch custom");
    const chosen = isHexColor(current);
    wheel.setAttribute("role", "radio");
    wheel.setAttribute("aria-checked", String(chosen));
    wheel.title = chosen ? `Custom color ${current}` : "Pick any color";
    if (chosen) wheel.style.background = current;
    const input = make("input");
    input.type = "color";
    input.value = chosen ? current : "#e0a458";
    input.setAttribute("aria-label", `${name}: pick any color`);
    input.addEventListener("change", () => onPick(input.value.toLowerCase() as HexColor));
    wheel.append(input);
    group.append(wheel);
  }
  return group;
}

/**
 * Kinds of work and status color individual events, which can only use
 * Google's 11 colors, so their pickers have no color wheel.
 */
const googleColor = (color: EventColor | HexColor | null): EventColor | undefined =>
  color && !isHexColor(color) ? color : undefined;

function chip(text: string, color: EventColor | HexColor | null | undefined): HTMLElement {
  const el = make("span", "chip", text);
  if (color) {
    el.style.background = colorHex(color);
    el.style.color = textColorOn(colorHex(color));
  } else el.dataset.none = "true";
  return el;
}

function reminderSelect(current: number[] | undefined, inherit: string | null, onPick: (m: number[] | undefined) => void) {
  const select = make("select");
  const options: { label: string; value: number[] | undefined }[] = [
    ...(inherit ? [{ label: inherit, value: undefined }] : []),
    ...REMINDERS.map((r) => ({ label: r.label, value: r.minutes })),
  ];
  const same = (a: number[] | undefined, b: number[] | undefined) => JSON.stringify(a) === JSON.stringify(b);
  if (current && !options.some((o) => same(o.value, current))) {
    options.push({ label: `Custom (${current.join(", ")} minutes before)`, value: current });
  }
  options.forEach((o, i) => {
    const el = make("option", "", o.label);
    el.value = String(i);
    el.selected = same(o.value, current);
    select.append(el);
  });
  select.addEventListener("change", () => onPick(options[Number(select.value)]!.value));
  return select;
}

interface ListedCourse {
  key: string;
  label: string;
  term: Term | null;
  /** Other names the class goes by (cross-listings, or classes the student merged in). */
  alsoKnownAs: { key: string; label: string }[];
}

/** The classes on your calendar, from the last sync on this computer, with their newest term. */
async function courseList(): Promise<ListedCourse[]> {
  const state = await chromeStore.load();
  const assignments = Object.values(state.cache).flatMap((c) => c.assignments);
  const tasks = mergeAssignments(assignments, {
    courseAliases: state.settings.courseAliases,
    courseMerges: state.settings.courseMerges,
  });
  const courses = new Map<string, { label: string; copies: Task["sources"]; alsoKnownAs: ListedCourse["alsoKnownAs"] }>();
  for (const task of tasks) {
    const course = courses.get(task.courseKey) ?? { label: task.courseLabel, copies: [], alsoKnownAs: task.alsoKnownAs ?? [] };
    course.copies.push(...task.sources);
    courses.set(task.courseKey, course);
  }
  return [...courses]
    .map(([key, { label, copies, alsoKnownAs }]) => ({ key, label, alsoKnownAs, term: newestTerm(copies.map((c) => c.course)) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Earlier semesters' classes stay tucked away unless the student asks for them. */
let showEarlier = false;

/**
 * "Also listed as ME 106A" for a class that goes by several names, or a
 * "Same class as…" choice for merging it into another one by hand.
 */
function sameClassControls(
  settings: Settings,
  key: string,
  label: string,
  alsoKnownAs: ListedCourse["alsoKnownAs"],
  others: ListedCourse[],
): HTMLElement {
  const row = make("div", "same-class muted hint");
  if (alsoKnownAs.length) {
    row.append(`Also listed as ${alsoKnownAs.map((a) => a.label).join(", ")}. `);
    // Only merges the student made can be undone; cross-listings Backpack found stay together.
    const keys = new Set([key, ...alsoKnownAs.map((a) => a.key)]);
    const separate = (merges: Record<string, string>) =>
      Object.fromEntries(Object.entries(merges).filter(([from, to]) => !keys.has(from) && !keys.has(to)));
    if (Object.keys(separate(settings.courseMerges)).length !== Object.keys(settings.courseMerges).length) {
      const split = make("button", "link", "Keep them separate");
      split.type = "button";
      split.addEventListener("click", () => update((s) => ({ ...s, courseMerges: separate(s.courseMerges) })));
      row.append(split);
    }
    return row;
  }
  const choices = others.filter((o) => o.key !== key);
  if (!choices.length) return row;
  const select = make("select");
  select.setAttribute("aria-label", `${label} is the same class as`);
  const own = make("option", "", "Its own class");
  own.value = "";
  select.append(own);
  for (const other of choices) {
    const option = make("option", "", `Same class as ${other.label}`);
    option.value = other.key;
    select.append(option);
  }
  select.addEventListener("change", () => {
    if (!select.value) return;
    void update((s) => ({ ...s, courseMerges: { ...s.courseMerges, [key]: select.value } }));
  });
  row.append(select);
  return row;
}

async function render() {
  const { settings } = await chromeStore.load();
  const now = Date.now();
  const listed = await courseList();
  const courses = listed.filter((c) => !isEarlierTerm(c.term, now));
  const earlier = listed.filter((c) => isEarlierTerm(c.term, now)).sort((a, b) => newestFirst(a.term, b.term));

  // Colors Backpack would pick on the next sync, shown (and kept) now.
  const colored = assignCourseColors(settings, courses.map((c) => c.key));
  if (colored) {
    await chromeStore.save({ settings: colored });
    return render();
  }

  $("no-courses").hidden = listed.length > 0;
  const toggle = $<HTMLButtonElement>("toggle-earlier");
  toggle.hidden = !earlier.length;
  toggle.textContent = showEarlier ? "Hide earlier semesters" : `Show earlier semesters (${earlier.length})`;
  toggle.setAttribute("aria-expanded", String(showEarlier));
  $("earlier-wrap").hidden = !showEarlier || !earlier.length;

  const courseRow = ({ key, label, term, alsoKnownAs }: ListedCourse, isEarlier: boolean, others: ListedCourse[]) => {
    const course = settings.courses[key] ?? {};
    const li = make("li");
    if (course.hidden) li.dataset.hidden = "true";
    const top = make("div", "top");
    const name = make("input");
    name.type = "text";
    name.placeholder = label;
    name.value = course.label ?? "";
    name.setAttribute("aria-label", `Name for ${label}`);
    name.addEventListener("change", () =>
      update((s) => {
        const value = name.value.trim();
        const next = { ...s.courses[key] };
        if (value) next.label = value;
        else delete next.label;
        return { ...s, courses: { ...s.courses, [key]: next } };
      }),
    );
    const hide = make("label", "hide");
    const box = make("input");
    box.type = "checkbox";
    box.checked = Boolean(course.hidden);
    box.addEventListener("change", () =>
      update((s) => ({ ...s, courses: { ...s.courses, [key]: { ...s.courses[key], hidden: box.checked } } })),
    );
    hide.append(box, "Hide");
    top.append(chip(course.label || label, course.color), name);
    if (isEarlier && term) top.append(make("span", "term", termName(term)));
    top.append(hide);
    li.append(
      top,
      swatches(
        course.color,
        "No color",
        `${label} color`,
        (color) => update((s) => ({ ...s, courses: { ...s.courses, [key]: { ...s.courses[key], color } } })),
        true,
      ),
    );

    // A custom color only shows exactly on the class's own calendar.
    if (isHexColor(course.color) && settings.calendars !== "perCourse") {
      const note = make("p", "muted hint note");
      note.append(`Shows as ${EVENT_COLORS[nearestEventColor(course.color)].name} on a shared calendar. `);
      const perCourse = make("button", "link", "Give each class its own calendar");
      perCourse.type = "button";
      perCourse.addEventListener("click", () => update((s) => switchCalendars(s, "perCourse")));
      note.append(perCourse, " for the exact color.");
      li.append(note);
    }

    li.append(sameClassControls(settings, key, label, alsoKnownAs, others));
    return li;
  };
  $("courses").replaceChildren(...courses.map((c) => courseRow(c, false, courses)));
  $("earlier-courses").replaceChildren(...earlier.map((c) => courseRow(c, true, earlier)));

  const general = reminderSelect(settings.reminders, null, (minutes) =>
    update((s) => ({ ...s, reminders: minutes ?? s.reminders })),
  );
  general.id = "reminders";
  $("reminders").replaceWith(general);

  $("kinds").replaceChildren(
    ...KINDS.map(({ kind, label, emoji }) => {
      const current = settings.kinds[kind] ?? {};
      const setKind = (patch: Partial<Settings["kinds"][AssignmentKind]>) =>
        update((s) => {
          const next = { ...s.kinds[kind], ...patch };
          for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined) delete next[k];
          return { ...s, kinds: { ...s.kinds, [kind]: next } };
        });
      const li = make("li");
      const top = make("div", "top");
      const emojiInput = make("input", "emoji");
      emojiInput.type = "text";
      emojiInput.maxLength = 4;
      emojiInput.placeholder = emoji;
      emojiInput.value = current.emoji ?? "";
      emojiInput.setAttribute("aria-label", `Emoji for ${label}`);
      emojiInput.addEventListener("change", () => setKind({ emoji: emojiInput.value.trim() || undefined }));
      const reminders = reminderSelect(current.reminders, "Same reminders as everything", (minutes) =>
        setKind({ reminders: minutes }),
      );
      reminders.setAttribute("aria-label", `Reminders for ${label}`);
      top.append(make("span", "name", label), emojiInput, reminders);
      li.append(
        top,
        swatches(current.color, "Class color", `${label} color`, (color) => setKind({ color: googleColor(color) })),
      );
      return li;
    }),
  );

  const status = settings.statusColors;
  $("submitted-color").replaceChildren(
    swatches(status.submitted, "Don't change", "Submitted work color", (color) =>
      update((s) => ({ ...s, statusColors: { ...s.statusColors, submitted: googleColor(color) } })),
    ),
  );
  $("due-soon-color").replaceChildren(
    swatches(status.dueSoon, "Don't change", "Due soon color", (color) =>
      update((s) => ({ ...s, statusColors: { ...s.statusColors, dueSoon: googleColor(color) } })),
    ),
  );
  const hours = $<HTMLSelectElement>("due-soon-hours");
  hours.replaceChildren(
    ...DUE_SOON_HOURS.map((h) => {
      const el = make("option", "", h < 24 ? `${h} hours` : `${h / 24} day${h === 24 ? "" : "s"}`);
      el.value = String(h);
      el.selected = h === status.dueSoonHours;
      return el;
    }),
  );
}

$("toggle-earlier").addEventListener("click", () => {
  showEarlier = !showEarlier;
  void render();
});

$("due-soon-hours").addEventListener("change", (e) => {
  const dueSoonHours = Number((e.target as HTMLSelectElement).value);
  void update((s) => ({ ...s, statusColors: { ...s.statusColors, dueSoonHours } }));
});

$("suggest-emoji").addEventListener("click", () =>
  update((s) => {
    const kinds = { ...s.kinds };
    for (const { kind, emoji } of KINDS) kinds[kind] = { ...kinds[kind], emoji: kinds[kind]?.emoji || emoji };
    return { ...s, kinds };
  }),
);

$("apply").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("apply");
  button.disabled = true;
  say("Updating your calendar…");
  const reply = await send({ type: "sync" });
  button.disabled = false;
  const { lastSync } = await chromeStore.load();
  if (!reply.ok) say(reply.error, "error");
  else if (lastSync) say(`Calendar updated: ${lastSync.updated} events changed.`, "ok");
});

void render();
