# Avatar Reminder — Windows starter

This is a runnable starter scaffold for a local-first Electron reminder app. It includes:
- Transparent, always-on-top desktop window and tray menu
- React UI with task creation and response buttons
- SQLite schema and reminder polling loop
- Browser speech synthesis for spoken reminders
- Three.js procedural avatar placeholder and optional VRM loading
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

The first launch uses a procedural placeholder avatar. To use a rigged 3D boy:
1. Obtain a VRM model you have permission to use.
2. Put it at `public/avatar.vrm`.
3. Ensure the model includes animation clips named with `Idle`, `Walk`, and optionally `Talk` for automatic mapping.
4. Restart the app.

A model without animation clips will load as a static model. For best results, use a VRM model plus compatible animation clips or add a retargeting pipeline.

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

## Other limitations

- OAuth tokens are encrypted with Electron `safeStorage` where available. On systems where encryption is unavailable, this starter stores the token data as base64 text; production builds should instead fail closed or implement a stronger secure token store.
- Speech and microphone recognition use browser-provided system features; recognition availability and transcription quality depend on the installed runtime and language services.
- The avatar's procedural placeholder is only for layout testing, not a final character asset.

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
