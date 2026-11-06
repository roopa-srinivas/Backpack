import type { Settings } from "./settings.js";
import type { Platform, Task } from "./types.js";

/** Deadlines this close count as the same time, like 11:59 PM and midnight. */
const SAME_TIME_MS = 5 * 60_000;

/** A reminder shows from this long before its time, the next time you open Google Calendar. */
export const REMIND_EARLY_MS = 30 * 60_000;

const DAY = 24 * 60 * 60_000;

/** One deadline the sites give for a piece of work, and which sites give it. */
export interface DueOption {
  dueAt: string;
  platforms: Platform[];
}

/** What the student said when the sites disagreed. */
export type DueAnswer =
  | { kind: "unanswered" }
  /** One of the sites' dates, or one the student typed in. */
  | { kind: "date"; dueAt: string; custom: boolean }
  /** Keep the date the calendar showed, and don't ask again. */
  | { kind: "keep" }
  | { kind: "later"; remindAt: number };

/** Sites disagreeing about a deadline, and what the student made of it. */
export interface DueQuestion {
  taskKey: string;
  courseLabel: string;
  title: string;
  options: DueOption[];
  /** What the calendar showed before the sites disagreed; it stays until the student answers. */
  heldDueAt: string | null;
  answer: DueAnswer;
  askedAt: number;
  answeredAt?: number;
  /** When Backpack first showed it to the student. */
  shownAt?: number;
}

const close = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_TIME_MS;

/**
 * The different deadlines a task's copies give, earliest first. A date an
 * approved extension replaced doesn't count: a site still showing it hasn't
 * caught up, it isn't a disagreement.
 */
export function dueOptions(task: Task): DueOption[] {
  const replaced = task.sources.flatMap((s) =>
    s.extension?.status === "approved" && s.extension.originalDueAt ? [s.extension.originalDueAt] : [],
  );
  const options: DueOption[] = [];
  for (const copy of task.sources) {
    if (!copy.dueAt || replaced.some((r) => close(r, copy.dueAt!))) continue;
    const same = options.find((o) => close(o.dueAt, copy.dueAt!));
    if (!same) options.push({ dueAt: copy.dueAt, platforms: [copy.platform] });
    else if (!same.platforms.includes(copy.platform)) same.platforms.push(copy.platform);
  }
  return options.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

/** Questions are about one set of dates: if a site moves again, it's a new question. */
const sameDates = (a: DueOption[], b: DueOption[]) =>
  a.length === b.length && a.every((o, i) => close(o.dueAt, b[i]!.dueAt));

/** Whether a question still needs an answer from the student. */
export const isOpen = (q: DueQuestion) => q.answer.kind === "unanswered" || q.answer.kind === "later";

/** Questions no one has been shown yet. */
export function unshown(questions: Record<string, DueQuestion>): string[] {
  return Object.values(questions)
    .filter((q) => q.answer.kind === "unanswered" && !q.shownAt)
    .map((q) => q.taskKey);
}

/** Questions whose "remind me" time has come (or is about to). */
export function dueReminders(questions: Record<string, DueQuestion>, now: number): string[] {
  return Object.values(questions)
    .filter((q) => q.answer.kind === "later" && now >= q.answer.remindAt - REMIND_EARLY_MS)
    .map((q) => q.taskKey);
}

export interface DueResolution {
  /** The tasks, with the deadline each should show on the calendar. */
  tasks: Task[];
  /** Every disagreement still around, to keep for next time. */
  questions: Record<string, DueQuestion>;
  /** Disagreements found on this sync, to ask about now. */
  fresh: string[];
}

/**
 * Settles each task's deadline when its sites disagree. Until the student
 * picks a date (or says to keep the calendar's), the calendar keeps the date
 * it showed before; one that was never on the calendar shows its best guess.
 * Only work still to do gets asked about: not submitted, not in a hidden
 * class, and with a deadline still ahead.
 *
 * `lastDue` is the deadline each task had on the calendar after the last sync.
 */
export function resolveDueDates(
  tasks: Task[],
  previous: Record<string, DueQuestion>,
  lastDue: Record<string, string | null>,
  settings: Settings,
  now: number,
): DueResolution {
  const questions: Record<string, DueQuestion> = {};
  const fresh: string[] = [];
  const resolved = tasks.map((task) => {
    const options = dueOptions(task);
    if (options.length < 2) return task;
    let question = previous[task.key];
    if (!question || !sameDates(question.options, options)) {
      const worthAsking =
        !task.submitted &&
        !settings.courses[task.courseKey]?.hidden &&
        options.some((o) => Date.parse(o.dueAt) > now);
      if (!worthAsking) return task;
      question = {
        taskKey: task.key,
        courseLabel: task.courseLabel,
        title: task.title,
        options,
        heldDueAt: lastDue[task.key] ?? null,
        answer: { kind: "unanswered" },
        askedAt: now,
      };
      fresh.push(task.key);
    }
    const label = settings.courses[task.courseKey]?.label?.trim() || task.courseLabel;
    questions[task.key] = { ...question, courseLabel: label, title: task.title, options };
    const dueAt = question.answer.kind === "date" ? question.answer.dueAt : (question.heldDueAt ?? task.dueAt);
    return { ...task, dueAt };
  });

  // Once its deadlines are all well past, a question's event is gone too.
  for (const [key, q] of Object.entries(questions)) {
    const dates = [...q.options.map((o) => o.dueAt), q.heldDueAt, q.answer.kind === "date" ? q.answer.dueAt : null];
    if (dates.every((d) => !d || Date.parse(d) < now - settings.pastDays * DAY)) delete questions[key];
  }
  return { tasks: resolved, questions, fresh: fresh.filter((key) => questions[key]) };
}
