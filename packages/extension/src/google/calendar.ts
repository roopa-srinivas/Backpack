import type { CalendarEventBody } from "@backpack/core";

const API = "https://www.googleapis.com/calendar/v3";

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Returns an OAuth token; `refresh` drops a rejected one and gets a new one. */
export interface TokenSource {
  token(): Promise<string>;
  refresh(rejected: string): Promise<string>;
}

export interface BackpackEventRef {
  id: string;
  task: string;
  hash: string;
}

/** The Google Calendar calls Backpack makes, on calendars it created. */
export class CalendarClient {
  constructor(
    private readonly auth: TokenSource,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let token = await this.auth.token();
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 401 && attempt === 0) {
        token = await this.auth.refresh(token);
        continue;
      }
      // Rate limited: back off and try again, up to three times.
      if ((response.status === 429 || response.status === 403) && attempt < 3) {
        const text = await response.clone().text();
        if (response.status === 429 || /rateLimitExceeded|userRateLimitExceeded/.test(text)) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
      }
      if (!response.ok) {
        const text = await response.text();
        throw new GoogleError(`Google Calendar answered ${response.status}: ${text.slice(0, 200)}`, response.status);
      }
      return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
    }
  }

  async createCalendar(summary: string, timeZone: string): Promise<string> {
    const created = await this.request<{ id: string }>("POST", "/calendars", { summary, timeZone });
    return created.id;
  }

  /** False when the calendar is gone (for example, the user deleted it). */
  async calendarExists(id: string): Promise<boolean> {
    try {
      await this.request("GET", `/calendars/${encodeURIComponent(id)}?fields=id`);
      return true;
    } catch (error) {
      if (error instanceof GoogleError && (error.status === 404 || error.status === 410)) return false;
      throw error;
    }
  }

  async renameCalendar(id: string, summary: string): Promise<void> {
    await this.request("PATCH", `/calendars/${encodeURIComponent(id)}`, { summary });
  }

  async deleteCalendar(id: string): Promise<void> {
    await this.request("DELETE", `/calendars/${encodeURIComponent(id)}`);
  }

  /** Every event on the calendar, split into Backpack's and anyone else's. */
  async listEvents(calendarId: string): Promise<{ backpack: BackpackEventRef[]; others: number }> {
    const backpack: BackpackEventRef[] = [];
    let others = 0;
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        maxResults: "2500",
        fields: "items(id,extendedProperties/private),nextPageToken",
        ...(pageToken ? { pageToken } : {}),
      });
      const page = await this.request<{
        items?: { id: string; extendedProperties?: { private?: Record<string, string> } }[];
        nextPageToken?: string;
      }>("GET", `/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
      for (const item of page.items ?? []) {
        const props = item.extendedProperties?.private;
        if (props?.backpack === "1" && props.task) backpack.push({ id: item.id, task: props.task, hash: props.hash ?? "" });
        else others++;
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return { backpack, others };
  }

  async insertEvent(calendarId: string, body: CalendarEventBody): Promise<void> {
    await this.request("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, body);
  }

  async replaceEvent(calendarId: string, eventId: string, body: CalendarEventBody): Promise<void> {
    await this.request("PUT", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, body);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.request("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    } catch (error) {
      // Already deleted by the user: nothing to do.
      if (error instanceof GoogleError && (error.status === 404 || error.status === 410)) return;
      throw error;
    }
  }
}
