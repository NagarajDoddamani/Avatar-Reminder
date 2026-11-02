# Avatar Reminder — Windows starter

This is a runnable starter scaffold for a local-first Electron reminder app. It includes:
- Transparent, always-on-top desktop window and tray menu
- React UI with task creation and response buttons
- SQLite schema and reminder polling loop
- Browser speech synthesis for spoken reminders
- Animated GLB avatar with a transparent, always-on-top reminder overlay
- Google Calendar OAuth callback, upcoming-event import, and event creation

## Prerequisites

- Windows 10/11
- Node.js 20 or later (LTS recommended)
- npm
- Visual Studio Build Tools may be needed if `better-sqlite3` has to compile locally

## Run

```powershell
npm install
npm run dev
```

Put a rigged GLB character at `public/models/avatar.glb`. The app loads it with Three.js and plays matching `walk`, `wave`, and `jump` clips when available. Missing idle or talk clips use subtle procedural rig motion; missing walk or gesture clips use a rig-aware fallback. If the GLB cannot load or WebGL is unavailable, the reminder board remains usable and reports that the 3D avatar could not be loaded.

## Google Calendar setup

1. Open Google Cloud Console and create a project.
2. Enable Google Calendar API.
3. Configure Google Auth Platform / OAuth consent screen.
4. Create an OAuth client with application type **Desktop app**.
5. Download its JSON file.
6. Copy it to the application's user data folder as `google-credentials.json`.

For a development build, the user data directory is printed by Electron APIs; on Windows it is typically under `%APPDATA%` in an app-specific folder. To make the folder name stable, set `app.setName('Avatar Reminder')` before `app.whenReady()` or inspect `app.getPath('userData')` while debugging.

The OAuth callback uses `http://127.0.0.1:43827/oauth2callback`. If Google rejects the redirect configuration, follow the current Google OAuth Desktop-app guidance for the selected client type rather than switching to a web client blindly.

This scaffold asks for read-only calendar access plus event creation. Review the current Google OAuth verification/testing rules before distributing the app.

## Calendar reminders and task lifecycle

Events from selected calendars are imported into `calendar_events` and linked to reminder tasks by calendar ID plus Google event ID. Sync updates these reminders, marks cancelled events inactive, and runs at startup, after the app returns online, and every 15 minutes while the app is running. Recurring event instances are expanded by Google Calendar. All-day events use the configurable local reminder time (09:00 by default).

Local reminders stay available when Google Calendar is disconnected. Completed reminders are archived one hour after completion; dismissed and cancelled reminders remain accessible under **All**. The scheduler runs while Avatar Reminder is open or minimized to the system tray. Choosing **Quit** stops the app, so reminders cannot fire while it is fully closed. Starting the app again rebuilds pending schedules and performs a calendar sync.

## Basic Needs reminders

Open **Basic Needs** from the top navigation to configure the predefined water, break, stretch, eye-rest, walking, posture, meal, sleep, exercise, and custom reminders. Drink Water is enabled initially with a 30-minute interval; the other templates start disabled. Each reminder can be edited, paused/resumed, or deleted. Schedules use the computer's local time and selected weekdays, including overnight time windows.

Reminder definitions are stored in `basic_reminders`. The scheduler creates one durable task occurrence at a time in `tasks`, with a unique definition/schedule key to prevent duplicate occurrences after restart. Completing or dismissing an occurrence advances the definition to its next scheduled time. If the app misses a scheduled occurrence by more than five minutes, it marks that occurrence skipped and moves on rather than replaying a backlog. Snoozed occurrences remain tied to the same definition.

## Other limitations

- OAuth tokens are encrypted with Electron `safeStorage` where available. On systems where encryption is unavailable, this starter stores the token data as base64 text; production builds should instead fail closed or implement a stronger secure token store.
- Speech and microphone recognition use browser-provided system features; recognition availability and transcription quality depend on the installed runtime and language services.
- The desktop overlay needs a running app process; choosing **Quit** stops reminders and avatar animations.

## Suggested next development steps

1. Add incremental Google sync tokens and remote event deletion reconciliation outside the selected date range.
2. Add a supported Windows background/startup mechanism if reminders must fire after choosing Quit.
3. Add robust retry handling, packaged Windows builds, and a stricter production Content Security Policy.

## Database tables

- `tasks`: local and calendar-linked reminders with lifecycle, schedule, snooze, completion, and expiry fields
- `reminder_history`: each fired reminder and user response
- `sync_log`: external sync operations and errors
- `app_settings`: app preferences and encrypted OAuth token blob
- `calendar_events`: source event metadata and stable calendar/event identifiers
- `calendar_sync_state`: per-calendar incremental Google sync tokens
- `basic_reminders`: persistent Basic Needs and user-created recurring reminder definitions
