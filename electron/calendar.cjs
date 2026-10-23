const fs = require('node:fs');
const http = require('node:http');
const { URL } = require('node:url');
const { google } = require('googleapis');
const crypto = require('node:crypto');

/*
Google OAuth setup:
1. Create a Google Cloud project and enable Google Calendar API.
2. Configure OAuth consent screen / Google Auth Platform.
3. Create an OAuth Client ID with application type "Desktop app".
4. Save the downloaded JSON to the app's userData directory as google-credentials.json.
   It must contain { installed: { client_id, client_secret, redirect_uris } }.
5. For production, review Google's current OAuth policies and use a verified app where required.
*/
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events'
];

function allDayInstant(dateValue, timeValue) {
  if (!dateValue) return null;
  const [year, month, day] = dateValue.split('-').map(Number);
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeValue || '09:00');
  const hour = match ? Math.min(23, Number(match[1])) : 9;
  const minute = match ? Math.min(59, Number(match[2])) : 0;
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function syncReminderTask(db, event, now, allDayReminderTime) {
  if (!event) return;
  const existing = db.prepare('SELECT * FROM tasks WHERE calendar_id=? AND google_event_id=? LIMIT 1').get(event.calendar_id, event.google_event_id);
  const cancelled = event.event_status === 'cancelled';
  const scheduledAt = event.all_day ? allDayInstant(event.start_at, allDayReminderTime) : (event.start_at ? new Date(event.start_at).toISOString() : null);
  const isUpcoming = scheduledAt && Date.parse(scheduledAt) > Date.parse(now);
  const message = event.description || `Your calendar event “${event.title}” is starting.`;
  let recurrence = event.recurrence_json || '[]';
  if (event.recurring_event_id || event.original_start_at) {
    recurrence = JSON.stringify({ rules: JSON.parse(recurrence), recurringEventId: event.recurring_event_id || null, originalStartTime: event.original_start_at || null });
  }
  if (!existing) {
    if (cancelled || !isUpcoming) return;
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO tasks
      (id,title,message,due_at,scheduled_reminder_at,recurrence,status,lifecycle_status,source,google_event_id,calendar_id,event_start_at,event_end_at,event_timezone,event_status,all_day,recurrence_json,last_synced_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'pending','scheduled','google_calendar',?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,event.title,message,scheduledAt,scheduledAt,recurrence,event.google_event_id,event.calendar_id,event.start_at,event.end_at,event.event_timezone,event.event_status,event.all_day,recurrence,now,now,now);
    return;
  }
  const protectedState = new Set(['completed','archived']);
  if (cancelled) {
    const lifecycle = protectedState.has(existing.lifecycle_status) ? existing.lifecycle_status : 'cancelled';
    const legacy = lifecycle === 'completed' || lifecycle === 'archived' ? 'completed' : lifecycle === 'dismissed' ? 'dismissed' : 'dismissed';
    db.prepare(`UPDATE tasks SET title=?,message=?,event_start_at=?,event_end_at=?,event_timezone=?,event_status='cancelled',all_day=?,recurrence_json=?,last_synced_at=?,lifecycle_status=?,status=?,updated_at=? WHERE id=?`)
      .run(event.title,message,event.start_at || existing.event_start_at,event.end_at || existing.event_end_at,event.event_timezone || existing.event_timezone,event.all_day,event.recurrence_json,now,lifecycle,legacy,now,existing.id);
    return;
  }
  let lifecycle = existing.lifecycle_status;
  let status = existing.status;
  let dueAt = existing.due_at;
  let nextSchedule = existing.scheduled_reminder_at;
  let snooze = existing.snooze_until;
  const timeChanged = existing.event_start_at !== event.start_at || existing.event_end_at !== event.end_at || existing.all_day !== event.all_day;
  if (existing.lifecycle_status === 'cancelled' && isUpcoming) {
    lifecycle = 'scheduled'; status = 'pending'; dueAt = scheduledAt; nextSchedule = scheduledAt; snooze = null;
  } else if (!protectedState.has(existing.lifecycle_status) && timeChanged) {
    if (isUpcoming) { lifecycle = 'scheduled'; status = 'pending'; dueAt = scheduledAt; nextSchedule = scheduledAt; snooze = null; }
    else { lifecycle = 'dismissed'; status = 'dismissed'; }
  }
  db.prepare(`UPDATE tasks SET title=?,message=?,due_at=?,scheduled_reminder_at=?,snooze_until=?,event_start_at=?,event_end_at=?,event_timezone=?,event_status=?,all_day=?,recurrence_json=?,last_synced_at=?,lifecycle_status=?,status=?,updated_at=? WHERE id=?`)
    .run(event.title,message,dueAt,nextSchedule,snooze,event.start_at,event.end_at,event.event_timezone,event.event_status,event.all_day,recurrence,now,lifecycle,status,now,existing.id);
}

function createCalendarService({ app, db, safeStorage, credentialsPath, googleClient = google }) {
  let oauthClient = null;
  let credentials = null;
  let calendarTimeZones = new Map();
  let syncQueue = Promise.resolve();

  function loadClient() {
    if (!fs.existsSync(credentialsPath)) {
      throw new Error(`Google credentials not found. Add google-credentials.json at: ${credentialsPath}`);
    }
    const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    credentials = raw.installed || raw.web;
    if (!credentials?.client_id || !credentials?.client_secret) {
      throw new Error('Credentials JSON is missing client_id or client_secret.');
    }
    oauthClient = new googleClient.auth.OAuth2(
      credentials.client_id,
      credentials.client_secret,
      'http://127.0.0.1:43827/oauth2callback'
    );

    const tokenRow = db.prepare("SELECT value FROM app_settings WHERE key = 'google_tokens'").get();
    if (tokenRow) {
      try {
        const encrypted = Buffer.from(tokenRow.value, 'base64');
        const tokenJson = safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(encrypted)
          : encrypted.toString('utf8');
        oauthClient.setCredentials(JSON.parse(tokenJson));
      } catch (error) {
        console.error('[calendar-auth] Could not read saved authorization data.', error?.name || 'Error');
      }
    }
    return oauthClient;
  }

  function saveTokens(tokens) {
    const current = oauthClient.credentials || {};
    const merged = { ...current, ...tokens };
    oauthClient.setCredentials(merged);
    const json = JSON.stringify(merged);
    const encrypted = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, 'utf8');
    db.prepare(`
      INSERT INTO app_settings(key, value, updated_at) VALUES ('google_tokens', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(encrypted.toString('base64'), new Date().toISOString());
  }

  async function connect() {
    const client = loadClient();
    const state = crypto.randomBytes(18).toString('hex');
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state
    });

    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const callbackUrl = new URL(req.url, 'http://127.0.0.1:43827');
          if (callbackUrl.pathname !== '/oauth2callback') return;
          if (callbackUrl.searchParams.get('state') !== state) {
            res.writeHead(400); res.end('Invalid OAuth state.'); server.close();
            return reject(new Error('OAuth state validation failed.'));
          }
          const code = callbackUrl.searchParams.get('code');
          if (!code) {
            res.writeHead(400); res.end('Authorization code missing.'); server.close();
            return reject(new Error('Google authorization code was not returned.'));
          }
          const { tokens } = await client.getToken(code);
          saveTokens(tokens);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>Google Calendar connected.</h2><p>You can close this tab and return to Avatar Reminder.</p>');
          server.close(() => resolve({ connected: true }));
        } catch (error) {
          res.writeHead(500); res.end('Authorization failed. Return to the app and try again.');
          server.close();
          reject(error);
        }
      });

      server.on('error', reject);
      server.listen(43827, '127.0.0.1', async () => {
        await app.whenReady();
        const { shell } = require('electron');
        await shell.openExternal(authUrl);
      });
      setTimeout(() => server.close(), 180000).unref();
    });
  }

  function getAuthorizedClient() {
    if (!oauthClient) loadClient();
    if (!oauthClient.credentials?.refresh_token && !oauthClient.credentials?.access_token) {
      throw new Error('Google Calendar is not connected yet.');
    }
    return oauthClient;
  }

  function logApiError(operation, calendarId, error) {
    const status = error?.response?.status || error?.code || 'unknown';
    const message = String(error?.response?.data?.error?.message || error?.message || 'Calendar API request failed')
      .replace(/https?:\/\/\S+/g, '[url]').replace(/\bBearer\s+\S+/gi, '[redacted]').slice(0, 300);
    console.error('[calendar-sync]', JSON.stringify({ operation, calendarId, status, error: message }));
    return { calendarId, status, message };
  }

  async function listCalendars() {
    const api = googleClient.calendar({ version: 'v3', auth: getAuthorizedClient() });
    const calendars = [];
    let pageToken;
    try {
      do {
        const response = await api.calendarList.list({ maxResults: 250, pageToken });
        for (const item of response.data.items || []) {
          calendars.push({ id: item.id, name: item.summary || item.id, primary: Boolean(item.primary), accessRole: item.accessRole || 'unknown', timeZone: item.timeZone || null, syncId: item.primary ? 'primary' : item.id });
        }
        pageToken = response.data.nextPageToken;
      } while (pageToken);
    } catch (error) {
      logApiError('calendarList.list', null, error);
      throw new Error(`Could not load Google calendars: ${String(error?.response?.data?.error?.message || error?.message || 'Calendar API request failed').slice(0, 240)}`);
    }
    calendarTimeZones = new Map(calendars.map(item => [item.syncId, item.timeZone]));
    // Deliberately limited to calendar metadata; no event titles or credentials are logged.
    console.info('[calendar-sync] calendars', JSON.stringify(calendars.map(({ name, id, primary, accessRole }) => ({ name, id, primary, accessRole }))));
    return calendars;
  }

  async function performCalendarSync({ calendarIds, timeMin, timeMax, incremental = false }) {
    const ids = [...new Set((calendarIds || []).filter(id => typeof id === 'string' && id.trim()))];
    if (!ids.length) throw new Error('Select at least one calendar to sync.');
    if (timeMin && Number.isNaN(Date.parse(timeMin))) throw new Error('The start of the date range is invalid.');
    if (timeMax && Number.isNaN(Date.parse(timeMax))) throw new Error('The end of the date range is invalid.');
    if (timeMin && timeMax && Date.parse(timeMax) <= Date.parse(timeMin)) throw new Error('The end date must be after the start date.');
    const api = googleClient.calendar({ version: 'v3', auth: getAuthorizedClient() });
    if (!calendarTimeZones.size) {
      try { await listCalendars(); } catch { /* The event request below reports per-calendar errors. */ }
    }
    const counts = { calendarsChecked: 0, eventsRetrieved: 0, eventsAdded: 0, eventsUpdated: 0, errors: [] };
    const getSyncState = db.prepare('SELECT sync_token FROM calendar_sync_state WHERE calendar_id=?');
    const saveSyncState = db.prepare(`INSERT INTO calendar_sync_state(calendar_id,sync_token,last_synced_at) VALUES(?,?,?)
      ON CONFLICT(calendar_id) DO UPDATE SET sync_token=excluded.sync_token,last_synced_at=excluded.last_synced_at`);
    const clearSyncState = db.prepare('DELETE FROM calendar_sync_state WHERE calendar_id=?');
    const selectExisting = db.prepare('SELECT id FROM calendar_events WHERE calendar_id = ? AND google_event_id = ?');
    const getStoredEvent = db.prepare('SELECT * FROM calendar_events WHERE calendar_id = ? AND google_event_id = ?');
    const upsert = db.prepare(`INSERT INTO calendar_events
      (id, calendar_id, google_event_id, title, description, location, start_at, end_at, all_day, recurrence_json, recurring_event_id, original_start_at, event_timezone, event_status, event_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(calendar_id, google_event_id) DO UPDATE SET
        title=CASE WHEN excluded.event_status='cancelled' THEN calendar_events.title ELSE excluded.title END,
        description=CASE WHEN excluded.event_status='cancelled' THEN calendar_events.description ELSE excluded.description END,
        location=CASE WHEN excluded.event_status='cancelled' THEN calendar_events.location ELSE excluded.location END,
        start_at=CASE WHEN excluded.event_status='cancelled' THEN calendar_events.start_at ELSE excluded.start_at END,
        end_at=CASE WHEN excluded.event_status='cancelled' THEN calendar_events.end_at ELSE excluded.end_at END,
        all_day=CASE WHEN excluded.event_status='cancelled' THEN calendar_events.all_day ELSE excluded.all_day END,
        recurrence_json=CASE WHEN excluded.event_status='cancelled' THEN calendar_events.recurrence_json ELSE excluded.recurrence_json END,
        recurring_event_id=CASE WHEN excluded.event_status='cancelled' THEN calendar_events.recurring_event_id ELSE excluded.recurring_event_id END,
        original_start_at=CASE WHEN excluded.event_status='cancelled' THEN calendar_events.original_start_at ELSE excluded.original_start_at END,
        event_timezone=CASE WHEN excluded.event_status='cancelled' THEN calendar_events.event_timezone ELSE excluded.event_timezone END,
        event_status=excluded.event_status,
        event_type=excluded.event_type, updated_at=excluded.updated_at`);
    for (const calendarId of ids) {
      counts.calendarsChecked++;
      let syncToken = incremental ? getSyncState.get(calendarId)?.sync_token : null;
      let retriedExpiredToken = false;
      console.info('[calendar-sync] querying', JSON.stringify({ calendarId, timeMin: incremental ? null : (timeMin || null), timeMax: incremental ? null : (timeMax || null), incremental, syncTokenUsed: Boolean(syncToken) }));
      while (true) {
        let pageToken;
        let nextSyncToken;
        let calendarRetrieved = 0, calendarAdded = 0, calendarUpdated = 0;
        try {
          do {
            const response = await api.events.list({
              calendarId, maxResults: 2500, singleEvents: true, showDeleted: true,
              ...(!incremental && timeMin ? { timeMin } : {}), ...(!incremental && timeMax ? { timeMax } : {}),
              ...(syncToken ? { syncToken } : {}), ...(pageToken ? { pageToken } : {})
            });
            const items = response.data.items || [];
            calendarRetrieved += items.length;
            const now = new Date().toISOString();
            const persistPage = db.transaction(events => {
              for (const event of events) {
                if (!event.id) continue;
                const existing = selectExisting.get(calendarId, event.id);
                const start = event.start?.dateTime || event.start?.date || null;
                const end = event.end?.dateTime || event.end?.date || null;
                upsert.run(existing?.id || crypto.randomUUID(), calendarId, event.id,
                  event.summary || '(Untitled event)', event.description || '', event.location || '',
                  start, end, event.start?.date ? 1 : 0, JSON.stringify(event.recurrence || []),
                  event.recurringEventId || null,
                  event.originalStartTime?.dateTime || event.originalStartTime?.date || null,
                  event.start?.timeZone || calendarTimeZones.get(calendarId) || null,
                  event.status || 'confirmed', event.eventType || 'default', now, now);
                syncReminderTask(db, getStoredEvent.get(calendarId, event.id), now, getAllDayReminderTime());
                if (existing) calendarUpdated++; else calendarAdded++;
              }
            });
            persistPage(items);
            pageToken = response.data.nextPageToken;
            nextSyncToken = response.data.nextSyncToken || nextSyncToken;
          } while (pageToken);
          counts.eventsRetrieved += calendarRetrieved;
          counts.eventsAdded += calendarAdded;
          counts.eventsUpdated += calendarUpdated;
          if (incremental && nextSyncToken) saveSyncState.run(calendarId, nextSyncToken, new Date().toISOString());
          console.info('[calendar-sync] result', JSON.stringify({ calendarId, eventsRetrieved: calendarRetrieved, incremental, syncTokenSaved: Boolean(incremental && nextSyncToken) }));
          break;
        } catch (error) {
          if (incremental && syncToken && !retriedExpiredToken && Number(error?.response?.status) === 410) {
            clearSyncState.run(calendarId);
            syncToken = null;
            retriedExpiredToken = true;
            continue;
          }
          counts.eventsRetrieved += calendarRetrieved;
          counts.eventsAdded += calendarAdded;
          counts.eventsUpdated += calendarUpdated;
          counts.errors.push(logApiError('events.list', calendarId, error));
          break;
        }
      }
    }
    return { ...counts, success: counts.errors.length === 0 };
  }

  function syncCalendars(options) {
    const result = syncQueue.then(() => performCalendarSync(options || {}));
    syncQueue = result.catch(() => {});
    return result;
  }

  function getImportedEvents() {
    return db.prepare('SELECT * FROM calendar_events ORDER BY CASE WHEN start_at IS NULL THEN 1 ELSE 0 END, start_at ASC, title COLLATE NOCASE').all();
  }

  function getAllDayReminderTime() {
    const row = db.prepare("SELECT value FROM app_settings WHERE key='allDayReminderTime'").get();
    try { return row ? JSON.parse(row.value) : '09:00'; } catch { return '09:00'; }
  }

  function updateAllDayReminderTime(value) {
    if (!/^\d{2}:\d{2}$/.test(value || '')) return 0;
    const rows = db.prepare(`SELECT id,event_start_at FROM tasks WHERE source='google_calendar' AND all_day=1
      AND lifecycle_status IN ('scheduled','snoozed') AND event_status='confirmed'`).all();
    const update = db.prepare(`UPDATE tasks SET due_at=?,scheduled_reminder_at=?,snooze_until=NULL,updated_at=? WHERE id=?`);
    const now = new Date().toISOString();
    const tx = db.transaction(items => { for (const task of items) { const at = allDayInstant(task.event_start_at, value); if (at) update.run(at, at, now, task.id); } });
    tx(rows);
    return rows.length;
  }

  async function createEvent(task) {
    const auth = getAuthorizedClient();
    const api = googleClient.calendar({ version: 'v3', auth });
    const start = new Date(task.due_at);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const response = await api.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: task.title,
        description: task.message || 'Created from Avatar Reminder',
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() }
      }
    });
    return response.data;
  }

  function status() {
    try {
      if (!oauthClient) loadClient();
      return {
        credentialsConfigured: fs.existsSync(credentialsPath),
        connected: Boolean(oauthClient.credentials?.refresh_token || oauthClient.credentials?.access_token)
      };
    } catch {
      return { credentialsConfigured: false, connected: false };
    }
  }

  return { connect, listCalendars, syncCalendars, getImportedEvents, updateAllDayReminderTime, createEvent, status };
}

module.exports = { createCalendarService };
