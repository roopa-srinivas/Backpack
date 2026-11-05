# Backpack

Backpack puts every assignment from Canvas, Gradescope and PrairieLearn on your Google Calendar, formatted the way you want.

Course sites each keep their own list of due dates, and the same homework often shows up on two of them. Backpack reads all of them using the logins already in your browser, merges the duplicates, and keeps a calendar up to date: new assignments appear, moved due dates move, and finished work gets checked off or removed.

**Status:** early. Canvas, Gradescope and PrairieLearn work today. Backpack also finds each course's website on bCourses; reading assignments from those websites is next, followed by a web dashboard for setting up your format with a live preview.

## How it works

- **Picking your platforms.** In the menu, check off every site your classes post assignments on. Checking one asks Chrome for permission to read just that site. Unchecking it removes its events on the next sync.
- **Reading assignments.** A Chrome extension reads your courses using your existing browser login. Canvas comes from its official API. Gradescope and PrairieLearn have no student API, so Backpack reads the course pages you'd see, skipping courses you teach or TA. PrairieLearn deadlines come from each assessment's credit schedule (the end of full credit, not the late period). No passwords are stored and nothing goes through a server.
- **Finding course websites.** Many classes post work on their own site (cs61a.org, eecs16a.org, ...). Backpack looks through each bCourses course for it: a navigation tab like "Course Website", then the Home page, the Syllabus, Modules and announcements. It skips links to Piazza, Ed, Zoom, Gradescope, Google Docs and similar tools. When it can't find a course's website, the Backpack icon shows a count, and the menu lets you type the address in or mark the course as having none. Backpack never replaces an address you entered. New courses are looked at on the next sync, and courses without a website are checked again once a week, since staff often add the link after the term starts. **Look again on bCourses** checks right away. Only this semester's courses are listed (and counted on the icon); **Show earlier semesters** lists the rest.
- **Merging duplicates.** Each piece of work goes on your calendar once, however many sites list it. "Homework 3" on Canvas and "HW03: Ruby Intro" on Gradescope in the same course become one event with both links, as does one lab posted on both a lecture and a lab bCourses site. Course names are matched across sites, so COMPSCI 169A and CS 169A count as the same course, and a course listed without a code (like "Robotics" on Gradescope) is matched to the course it shares assignments with. Two courses that both have codes are never merged, and two assignments on the same course site are never merged with each other.
- **Your format.** Choose one calendar, one per class or one per platform. With one per class, each class is its own calendar in Google Calendar's "My calendars" list, in the class's color, so you can turn classes on and off; class names then come out of event titles, since the calendar says which class it is. Every event's notes start with its class. Show each assignment as an all-day event, a short event at the due time, or a work block before it. Write your own event titles from `{course}`, `{title}`, `{platform}`, `{kind}` and `{points}`.
- **Colors, reminders and emoji.** Each class gets its own color automatically. On the Personalize page (Colors, reminders and emoji… in the menu) you can rename a class, change or remove its color, or hide it. A class can have any color from the color wheel: Google Calendar events only come in 11 colors, so a custom color shows exactly when each class has its own calendar (Backpack colors that calendar), and as the nearest of the 11 on a shared calendar. Each kind of work (homework, projects, labs, quizzes, exams, discussions) can have its own color, an emoji at the start of its title, and its own reminders, such as a week before exams. Submitted work can turn one color and work due soon (or overdue) another. When colors overlap, where the work stands wins, then the kind of work, then the class. Only this semester's classes are listed and given colors automatically, so old classes never use up the colors; **Show earlier semesters** brings them back. The current semester comes from the date (Fall from mid-August, Spring from mid-January, Summer from late May); upcoming semesters and courses with no semester listed always show.
- **Staying in sync.** Every 3 hours, or when you click Sync now, Backpack compares what should be on your calendar with what is, and only makes the changes needed. It only touches calendars it created, and never deletes a calendar you've added your own events to.
- **When a site is down.** If a site can't be reached, its events stay as they were until the next good sync.
- **On more than one computer.** Your setup (checked sites, format, course websites) and the list of Backpack's calendars are shared through Chrome sync, so every computer where you use Backpack writes to the same calendars instead of each adding its own copy of every event. If two computers set up at the same moment and each make a calendar, the extra one is removed on a later sync (only Backpack's events in it, if you've added your own). A computer that can't read one of your sites yet (for example, you haven't signed in to Gradescope there) leaves the calendar alone until it can.

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

Backpack reads course pages only on the sites you allow and writes only to calendars it created. Assignments it reads stay in this browser's extension storage. Your setup (checked sites, school addresses, format, course websites) and the ids of Backpack's calendars are kept in Chrome's synced extension storage, so with Chrome sync on they're shared with your other computers through your Google account. There's no Backpack server.
