import type { TokenSource } from "./calendar.js";

/** Google sign-in through Chrome's built-in account support. */
export function chromeTokenSource(interactive: boolean): TokenSource {
  return {
    async token() {
      const result = await chrome.identity.getAuthToken({ interactive });
      if (!result.token) throw new Error("Connect Google Calendar from the Backpack menu first.");
      return result.token;
    },
    async refresh(rejected) {
      await chrome.identity.removeCachedAuthToken({ token: rejected });
      const result = await chrome.identity.getAuthToken({ interactive });
      if (!result.token) throw new Error("Google sign-in expired. Connect Google Calendar again.");
      return result.token;
    },
  };
}

/** True when a token is available without asking the user. */
export async function isGoogleConnected(): Promise<boolean> {
  try {
    const result = await chrome.identity.getAuthToken({ interactive: false });
    return Boolean(result.token);
  } catch {
    return false;
  }
}
