import type { Platform } from "@backpack/core";
import type { State } from "./state.js";

/**
 * The platforms students can check off in the menu. Readers live in
 * sources/ and are only loaded by the background worker, so the menu stays small.
 */
export interface PlatformInfo {
  platform: Platform;
  label: string;
  /** False for platforms Backpack can't read yet; they show as "Coming soon". */
  available: boolean;
  /** Sites Backpack needs permission to read, or null when setup isn't finished. */
  origins(state: State): string[] | null;
}

/** The shared PrairieLearn server most schools, Berkeley included, use. */
export const DEFAULT_PRAIRIELEARN_HOST = "us.prairielearn.com";

export const prairielearnHost = (state: State) => state.prairielearnHost || DEFAULT_PRAIRIELEARN_HOST;

export const PLATFORMS: PlatformInfo[] = [
  {
    platform: "canvas",
    label: "bCourses (Canvas)",
    available: true,
    origins: (state) => (state.canvasHost ? [`https://${state.canvasHost}/*`] : null),
  },
  {
    platform: "gradescope",
    label: "Gradescope",
    available: true,
    origins: () => ["https://www.gradescope.com/*"],
  },
  {
    platform: "prairielearn",
    label: "PrairieLearn",
    available: true,
    origins: (state) => [`https://${prairielearnHost(state)}/*`],
  },
];

export function platformInfo(platform: Platform): PlatformInfo {
  return PLATFORMS.find((p) => p.platform === platform)!;
}
