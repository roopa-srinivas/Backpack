# Backpack

Backpack puts every assignment from Canvas, Gradescope and PrairieLearn on your Google Calendar, formatted the way you want.

Course sites each keep their own list of due dates, and the same homework often shows up on two of them. Backpack reads all of them using the logins already in your browser, merges the duplicates, and keeps a calendar up to date: new assignments appear, moved due dates move, and finished work gets checked off or removed.

**Status:** early. Canvas, Gradescope and PrairieLearn work today. Course websites are next, followed by a web dashboard for setting up your format with a live preview.

## How it works

- **Picking your platforms.** In the menu, check off every site your classes post assignments on. Checking one asks Chrome for permission to read just that site. Unchecking it removes its events on the next sync.
- **Reading assignments.** A Chrome extension reads your courses using your existing browser login. Canvas comes from its official API. Gradescope and PrairieLearn have no student API, so Backpack reads the course pages you'd see, skipping courses you teach or TA. PrairieLearn deadlines come from each assessment's credit schedule (the end of full credit, not the late period). No passwords are stored and nothing goes through a server.
- **Merging duplicates.** "Homework 3" on Canvas and "HW3: Ruby Intro" on Gradescope in the same course become one calendar event with both links. Course names are matched across sites, so COMPSCI 169A and CS 169A count as the same course.
- **Your format.** Choose one calendar, one per course or one per platform. Show each assignment as an all-day event, a short event at the due time, or a work block before it. Write your own event titles from `{course}`, `{title}`, `{platform}`, `{kind}` and `{points}`, and set reminders, course colors and labels.
- **Staying in sync.** Every 3 hours, or when you click Sync now, Backpack compares what should be on your calendar with what is, and only makes the changes needed. It only touches calendars it created, and never deletes a calendar you've added your own events to.
- **When a site is down.** If a site can't be reached, its events stay as they were until the next good sync.

## Project layout

| Folder | What's in it |
|---|---|
| `packages/core` | The sync logic in plain TypeScript: matching courses, merging duplicates, building events from your settings, and planning the calendar changes. |
| `packages/extension` | The Chrome extension (Manifest V3): readers for each platform (`src/sources`), the platform checklist (`src/platforms.ts`), the Google Calendar client, background syncing and the menu. |

## Run it locally

You need Node 24 and Chrome.

```sh
npm install
npm run check   # types, lint and tests
npm run build   # builds packages/extension/dist
```

In Chrome, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select `packages/extension/dist`.

### Google Calendar setup (one time)

Backpack signs in to Google through Chrome, which needs an OAuth client of your own:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the **Google Calendar API**.
2. Under **Google Auth Platform**, set up the consent screen (External, testing mode) and add your Google account as a test user.
3. Add the scope `https://www.googleapis.com/auth/calendar.app.created`. It lets Backpack manage only the calendars it creates.
4. Create an OAuth client of type **Chrome extension**, using the extension id that `npm run build` prints.
5. Put the client id in `.env.local` at the repo root, then rebuild:

   ```sh
   BACKPACK_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   ```

The first build creates `keys/backpack.pem`, which keeps the extension id the same across builds. It's private and git-ignored.

## Privacy

Backpack reads course pages only on the sites you allow, keeps everything in your browser's extension storage, and writes only to calendars it created. There's no Backpack server.
