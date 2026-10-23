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

## Important starter limitations

- The reminder scheduler polls every 15 seconds and supports one-time reminders. Recurrence values are stored but recurring-task rescheduling is not yet implemented.
- Reminders are marked `reminded` before displaying, preventing duplicates but not automatically retrying after a crash at that exact moment.
- Google Calendar import currently displays upcoming events but does not yet persist them as local tasks or reconcile remote edits/deletions.
- The first calendar sync path creates a new event; update/delete conflict handling and duplicate detection should be added before production.
- OAuth tokens are encrypted with Electron `safeStorage` where available. On systems where encryption is unavailable, this starter stores the token data as base64 text; production builds should instead fail closed or implement a stronger secure token store.
- Speech uses the browser's installed system voices. Speech recognition, microphone permissions and a natural-language task parser are not included yet.
- The avatar's procedural placeholder is only for layout testing, not a final character asset.

## Suggested next development steps

1. Add recurring schedules and timezone-aware recurrence rules.
2. Persist imported Google events and track sync tokens / `updated` timestamps.
3. Add a settings page for quiet hours, voice, avatar position and startup behavior.
4. Add microphone input and a task parser with a confirmation step before creating events.
5. Add robust retry handling, structured logs, unit tests, and packaged Windows builds.
6. Validate IPC sender and payloads, add a stricter production Content Security Policy, and audit dependencies before release.

## Database tables

- `tasks`: reminder definitions and status
- `reminder_history`: each fired reminder and user response
- `sync_log`: external sync operations and errors
- `app_settings`: app preferences and encrypted OAuth token blob
