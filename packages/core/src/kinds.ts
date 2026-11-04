import type { AssignmentKind } from "./types.js";

/**
 * Guesses what kind of work an assignment is from its title, for platforms
 * that don't say. "Midterm 1" is an exam, "Proj 2A" a project, and so on.
 */
export function kindFromTitle(title: string): AssignmentKind {
  if (/\b(exam|midterm|final)\b/i.test(title)) return "exam";
  if (/\bquiz(zes)?\b/i.test(title)) return "quiz";
  if (/\bproj(ect)?\b/i.test(title)) return "project";
  if (/\blab\b/i.test(title)) return "lab";
  if (/\bdisc(ussion)?\b/i.test(title)) return "discussion";
  return "assignment";
}
