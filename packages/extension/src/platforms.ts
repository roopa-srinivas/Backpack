import type { Platform } from "@backpack/core";
import type { State } from "./state.js";

/**
 * The platforms students can check off in the menu. Readers live in
 * sources/ and are only loaded by the background worker, so the menu stays small.
 */
export interface PlatformInfo {
  platform: Platform;
  label: string;
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
    origins: (state) => (state.canvasHost ? [`https://${state.canvasHost}/*`] : null),
  },
  {
    platform: "gradescope",
    label: "Gradescope",
    origins: () => ["https://www.gradescope.com/*"],
  },
  {
    platform: "prairielearn",
    label: "PrairieLearn",
    origins: (state) => [`https://${prairielearnHost(state)}/*`],
  },
  {
    platform: "flextensions",
    label: "Flextensions",
    origins: () => ["https://flextensions.berkeley.edu/*"],
  },
];

export function platformInfo(platform: Platform): PlatformInfo {
  return PLATFORMS.find((p) => p.platform === platform)!;
}
