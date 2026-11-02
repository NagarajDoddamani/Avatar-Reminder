const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCalendarService } = require('./calendar.cjs');

test('lists calendar metadata and imports paginated ordinary, all-day, recurring, and birthday events', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-calendar-test-'));
  const credentialsPath = path.join(directory, 'google-credentials.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({ installed: { client_id: 'test-client', client_secret: 'test-secret' } }));
  const savedRows = new Map();
  const savedTasks = new Map();
  const syncStates = new Map();
  const db = {
    prepare(sql) {
      if (sql.includes("SELECT value FROM app_settings WHERE key = 'google_tokens'")) return { get: () => ({ value: Buffer.from(JSON.stringify({ refresh_token: 'test-refresh-token' })).toString('base64') }) };
      if (sql.includes('SELECT sync_token FROM calendar_sync_state')) return { get: id => syncStates.get(id) };
      if (sql.includes('INSERT INTO calendar_sync_state')) return { run: (id,token,at) => syncStates.set(id,{sync_token:token,last_synced_at:at}) };
      if (sql.includes('DELETE FROM calendar_sync_state')) return { run: id => syncStates.delete(id) };
      if (sql.includes('SELECT id FROM calendar_events')) return { get: (calendarId, eventId) => savedRows.get(`${calendarId}|${eventId}`) };
      if (sql.includes('SELECT * FROM calendar_events')) return { get: (calendarId, eventId) => savedRows.get(`${calendarId}|${eventId}`) };
      if (sql.includes('INSERT INTO calendar_events')) return { run: (...args) => { const key=`${args[1]}|${args[2]}`,old=savedRows.get(key); savedRows.set(key,{id:args[0],calendar_id:args[1],google_event_id:args[2],title:args[13]==='cancelled'&&old?old.title:args[3],description:args[13]==='cancelled'&&old?old.description:args[4],location:args[13]==='cancelled'&&old?old.location:args[5],start_at:args[13]==='cancelled'&&old?old.start_at:args[6],end_at:args[13]==='cancelled'&&old?old.end_at:args[7],all_day:args[13]==='cancelled'&&old?old.all_day:args[8],recurrence_json:args[13]==='cancelled'&&old?old.recurrence_json:args[9],recurring_event_id:args[13]==='cancelled'&&old?old.recurring_event_id:args[10],original_start_at:args[13]==='cancelled'&&old?old.original_start_at:args[11],event_timezone:args[13]==='cancelled'&&old?old.event_timezone:args[12],event_status:args[13],args}); } };
      if (sql.includes('SELECT * FROM tasks WHERE calendar_id')) return { get: (calendarId, eventId) => savedTasks.get(`${calendarId}|${eventId}`) };
      if (sql.includes('INSERT INTO tasks')) return { run: (...a) => savedTasks.set(`${a[7]}|${a[6]}`, { id:a[0],title:a[1],message:a[2],due_at:a[3],scheduled_reminder_at:a[4],recurrence:a[5],status:'pending',lifecycle_status:'scheduled',source:'google_calendar',google_event_id:a[6],calendar_id:a[7],event_start_at:a[8],event_end_at:a[9],event_timezone:a[10],event_status:a[11],all_day:a[12],recurrence_json:a[13],last_synced_at:a[14] }) };
      if (sql.includes("UPDATE tasks SET title=?,message=?,event_start_at=?")) return { run: (...a) => { const row=[...savedTasks.values()].find(item=>item.id===a[11]); if(row) Object.assign(row,{title:a[0],message:a[1],event_start_at:a[2],event_end_at:a[3],event_timezone:a[4],event_status:'cancelled',all_day:a[5],recurrence_json:a[6],last_synced_at:a[7],lifecycle_status:a[8],status:a[9]}); } };
      if (sql.includes('UPDATE tasks SET title=?,message=?,due_at=')) return { run: (...a) => { const row=[...savedTasks.values()].find(item=>item.id===a[15]); if(row) Object.assign(row,{title:a[0],message:a[1],due_at:a[2],scheduled_reminder_at:a[3],snooze_until:a[4],event_start_at:a[5],event_end_at:a[6],event_timezone:a[7],event_status:a[8],all_day:a[9],recurrence_json:a[10],last_synced_at:a[11],lifecycle_status:a[12],status:a[13]}); } };
      if (sql.includes("SELECT value FROM app_settings WHERE key='allDayReminderTime'")) return { get: () => undefined };
      throw new Error(`Unexpected SQL in calendar sync test: ${sql}`);
    },
    transaction(fn) { return fn; }
  };
  let listRequests = [];
  let meetingEvent = { id: 'meeting-1', summary: 'Planning', description: 'Agenda', location: 'Room 2', start: { dateTime: '2026-11-24T09:00:00-04:00' }, end: { dateTime: '2026-11-24T10:00:00-04:00' }, recurrence: ['RRULE:FREQ=WEEKLY'], recurringEventId: 'meeting-series', originalStartTime: { dateTime: '2026-11-24T09:00:00-04:00' }, status: 'confirmed', eventType: 'default' };
  const fakeGoogle = {
    auth: { OAuth2: class { setCredentials(value) { this.credentials = value; } } },
    calendar: () => ({
      calendarList: { list: async ({ pageToken }) => pageToken
        ? { data: { items: [{ id: 'shared-id', summary: 'Shared work', accessRole: 'reader' }] } }
        : { data: { items: [{ id: 'owner@example.test', summary: 'My calendar', primary: true, accessRole: 'owner' }], nextPageToken: 'cal-page-2' } } },
      events: { list: async params => {
        listRequests.push(params);
        if (params.syncToken === 'expired-token') { const error=new Error('Sync token expired');error.response={status:410};throw error; }
        if (params.syncToken) return { data: { items: [meetingEvent], nextSyncToken:'sync-token-2' } };
        if (params.pageToken) return { data: { items: [
          { id: 'all-day-1', summary: 'Company day', start: { date: '2026-11-25' }, end: { date: '2026-11-26' }, status: 'confirmed', eventType: 'default' },
          { id: 'birthday-1', summary: 'Birthday', start: { dateTime: '2026-11-26T09:00:00-04:00' }, end: { dateTime: '2026-11-26T09:30:00-04:00' }, eventType: 'birthday', status: 'confirmed' }
        ], nextSyncToken:'sync-token-1' } };
        return { data: { items: [meetingEvent], nextPageToken: 'event-page-2' } };
      } }
    })
  };
  try {
    const service = createCalendarService({ app: {}, db, safeStorage: { isEncryptionAvailable: () => false }, credentialsPath, googleClient: fakeGoogle });
    const calendars = await service.listCalendars();
    assert.deepEqual(calendars.map(({ syncId }) => syncId), ['primary', 'shared-id']);
    const result = await service.syncCalendars({ calendarIds: ['primary'], timeMin: '2026-11-01T00:00:00.000Z', timeMax: '2026-12-01T00:00:00.000Z' });
    assert.deepEqual({ success: result.success, calendarsChecked: result.calendarsChecked, eventsRetrieved: result.eventsRetrieved, eventsAdded: result.eventsAdded, eventsUpdated: result.eventsUpdated }, { success: true, calendarsChecked: 1, eventsRetrieved: 3, eventsAdded: 3, eventsUpdated: 0 });
    assert.equal(listRequests.length, 2);
    assert.equal(listRequests[0].calendarId, 'primary');
    assert.equal(listRequests[1].pageToken, 'event-page-2');
    assert.equal('eventTypes' in listRequests[0], false);
    const meeting = savedRows.get('primary|meeting-1').args;
    assert.equal(meeting[2], 'meeting-1');
    assert.equal(meeting[3], 'Planning');
    assert.equal(meeting[4], 'Agenda');
    assert.equal(meeting[5], 'Room 2');
    assert.equal(meeting[8], 0);
    assert.deepEqual(JSON.parse(meeting[9]), ['RRULE:FREQ=WEEKLY']);
    assert.equal(meeting[10], 'meeting-series');
    assert.equal(meeting[11], '2026-11-24T09:00:00-04:00');
    assert.equal(savedRows.get('primary|all-day-1').args[8], 1);
    assert.equal(savedRows.has('primary|birthday-1'), true);
    assert.equal(savedTasks.size,3);
    assert.equal(savedTasks.get('primary|meeting-1').source,'google_calendar');
    assert.equal(savedTasks.get('primary|meeting-1').lifecycle_status,'scheduled');
    const secondSync = await service.syncCalendars({ calendarIds: ['primary'], timeMin: '2026-11-01T00:00:00.000Z', timeMax: '2026-12-01T00:00:00.000Z' });
    assert.equal(secondSync.eventsAdded, 0);
    assert.equal(secondSync.eventsUpdated, 3);
    assert.equal(savedRows.size, 3);
    assert.equal(savedTasks.size,3);
    const allDayTask=savedTasks.get('primary|all-day-1');
    assert.equal(new Date(allDayTask.scheduled_reminder_at).getHours(),9);
    meetingEvent={...meetingEvent,summary:'Planning moved',description:'New agenda',start:{dateTime:'2026-11-25T10:00:00Z'},end:{dateTime:'2026-11-25T11:00:00Z'},originalStartTime:{dateTime:'2026-11-25T10:00:00Z'}};
    await service.syncCalendars({calendarIds:['primary'],timeMin:'2026-11-01T00:00:00.000Z',timeMax:'2026-12-01T00:00:00.000Z'});
    const linkedTask=savedTasks.get('primary|meeting-1');
    assert.equal(linkedTask.title,'Planning moved');
    assert.equal(linkedTask.lifecycle_status,'scheduled');
    assert.equal(linkedTask.scheduled_reminder_at,'2026-11-25T10:00:00.000Z');
    meetingEvent={id:'meeting-1',status:'cancelled'};
    await service.syncCalendars({calendarIds:['primary'],timeMin:'2026-11-01T00:00:00.000Z',timeMax:'2026-12-01T00:00:00.000Z'});
    assert.equal(linkedTask.lifecycle_status,'cancelled');
    assert.equal(savedRows.get('primary|meeting-1').title,'Planning moved');
    meetingEvent={id:'meeting-1',summary:'Planning restored',description:'Agenda restored',start:{dateTime:'2026-11-26T10:00:00Z'},end:{dateTime:'2026-11-26T11:00:00Z'},status:'confirmed'};
    const beforeInitialToken=listRequests.length;
    await service.syncCalendars({calendarIds:['primary'],incremental:true});
    assert.equal(syncStates.get('primary').sync_token,'sync-token-1');
    assert.equal('timeMin' in listRequests[beforeInitialToken],false);
    const beforeDelta=listRequests.length;
    await service.syncCalendars({calendarIds:['primary'],incremental:true});
    assert.equal(listRequests[beforeDelta].syncToken,'sync-token-1');
    assert.equal('orderBy' in listRequests[beforeDelta],false);
    assert.equal(linkedTask.title,'Planning restored');
    assert.equal(linkedTask.lifecycle_status,'scheduled');
    syncStates.set('primary',{sync_token:'expired-token'});
    const beforeExpired=listRequests.length;
    const recovered=await service.syncCalendars({calendarIds:['primary'],incremental:true});
    assert.equal(recovered.success,true);
    assert.equal(listRequests[beforeExpired].syncToken,'expired-token');
    assert.equal(listRequests[beforeExpired+1].syncToken,undefined);
    assert.equal(syncStates.get('primary').sync_token,'sync-token-1');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
