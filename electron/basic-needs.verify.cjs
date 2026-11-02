const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDatabase } = require('./store.cjs');
const {
  listBasicNeedsReminders, saveBasicReminder, setBasicReminderEnabled,
  ensureBasicNeedsOccurrences, claimDueTasks, respondToTask, deleteBasicReminder
} = require('./reminders.cjs');

function makeDb(file = ':memory:') { return openDatabase(file); }
function water(db, at, overrides = {}) {
  const reminder = listBasicNeedsReminders(db, at).find(item => item.template_key === 'drink-water');
  saveBasicReminder(db, {
    id: reminder.id, title: 'Drink Water', message: 'Have a glass of water.', intervalMinutes: 30,
    startTime: '09:00', endTime: '21:00', activeDays: [0,1,2,3,4,5,6], enabled: true,
    soundEnabled: false, speakEnabled: true, ...overrides
  }, at);
  return reminder.id;
}
function activeOccurrences(db, reminderId) {
  return db.prepare(`SELECT * FROM tasks WHERE basic_reminder_id=? AND lifecycle_status IN ('scheduled','snoozed','due','notified') ORDER BY scheduled_reminder_at`).all(reminderId);
}

function verifyWaterCompletesAndRepeats() {
  const db = makeDb();
  try {
    const now = new Date(2026, 9, 23, 10, 0, 0);
    const templates = listBasicNeedsReminders(db, now);
    assert.equal(templates.length, 10);
    assert.equal(templates.find(item => item.template_key === 'drink-water').interval_minutes, 30);
    assert.equal(templates.find(item => item.template_key === 'drink-water').enabled, 1);
    const reminderId = water(db, now);
    assert.equal(ensureBasicNeedsOccurrences(db, now), 1);
    let [occurrence] = activeOccurrences(db, reminderId);
    assert.equal(new Date(occurrence.scheduled_reminder_at).getTime(), new Date(2026, 9, 23, 10, 30).getTime());
    const due = claimDueTasks(db, occurrence.scheduled_reminder_at);
    assert.equal(due.length, 1);
    assert.equal(claimDueTasks(db, occurrence.scheduled_reminder_at).length, 0);
    assert.equal(due[0].source, 'basic_needs');
    assert.equal(due[0].speak_enabled, 1);
    respondToTask(db, occurrence.id, 'done', new Date(2026, 9, 23, 10, 31));
    assert.equal(ensureBasicNeedsOccurrences(db, new Date(2026, 9, 23, 10, 31)), 1);
    [occurrence] = activeOccurrences(db, reminderId);
    assert.equal(new Date(occurrence.scheduled_reminder_at).getTime(), new Date(2026, 9, 23, 11, 0).getTime());
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM basic_reminders WHERE id=?').get(reminderId).count, 1);
  } finally { db.close(); }
}

function verifyPauseResumeAndIntervalChange() {
  const db = makeDb();
  try {
    const now = new Date(2026, 9, 23, 10, 0);
    const id = water(db, now);
    ensureBasicNeedsOccurrences(db, now);
    const [oldOccurrence] = activeOccurrences(db, id);
    setBasicReminderEnabled(db, id, false, new Date(2026, 9, 23, 10, 5));
    assert.equal(activeOccurrences(db, id).length, 0);
    assert.equal(db.prepare('SELECT lifecycle_status FROM tasks WHERE id=?').get(oldOccurrence.id).lifecycle_status, 'paused');
    db.prepare("UPDATE tasks SET lifecycle_status='snoozed',scheduled_reminder_at=? WHERE id=?").run(new Date(2026, 9, 23, 10, 5).toISOString(), oldOccurrence.id);
    assert.equal(claimDueTasks(db, new Date(2026, 9, 23, 10, 6).toISOString()).length, 0);
    db.prepare("UPDATE tasks SET lifecycle_status='paused',scheduled_reminder_at=? WHERE id=?").run(oldOccurrence.scheduled_reminder_at, oldOccurrence.id);
    setBasicReminderEnabled(db, id, true, new Date(2026, 9, 23, 10, 6));
    assert.equal(ensureBasicNeedsOccurrences(db, new Date(2026, 9, 23, 10, 6)), 0);
    const [resumed] = activeOccurrences(db, id);
    assert.equal(resumed.id, oldOccurrence.id);
    assert.equal(new Date(resumed.scheduled_reminder_at).getTime(), new Date(2026, 9, 23, 10, 30).getTime());

    const definition = db.prepare('SELECT * FROM basic_reminders WHERE id=?').get(id);
    saveBasicReminder(db, { id, title: definition.title, message: definition.message, intervalMinutes: 20,
      startTime: '09:00', endTime: '21:00', activeDays: [0,1,2,3,4,5,6], enabled: true }, new Date(2026, 9, 23, 10, 7));
    ensureBasicNeedsOccurrences(db, new Date(2026, 9, 23, 10, 7));
    const [changed] = activeOccurrences(db, id);
    assert.equal(db.prepare('SELECT lifecycle_status FROM tasks WHERE id=?').get(resumed.id).lifecycle_status, 'cancelled');
    assert.equal(new Date(changed.scheduled_reminder_at).getTime(), new Date(2026, 9, 23, 10, 20).getTime());
  } finally { db.close(); }
}

function verifyRestartAndNoDuplicates() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-basic-needs-'));
  const file = path.join(folder, 'reminders.sqlite3');
  try {
    const now = new Date(2026, 9, 23, 10, 0);
    let db = makeDb(file);
    const id = water(db, now);
    assert.equal(ensureBasicNeedsOccurrences(db, now), 1);
    const before = activeOccurrences(db, id)[0];
    db.close();
    db = makeDb(file);
    assert.equal(ensureBasicNeedsOccurrences(db, new Date(2026, 9, 23, 10, 1)), 0);
    assert.equal(ensureBasicNeedsOccurrences(db, new Date(2026, 9, 23, 10, 2)), 0);
    const after = activeOccurrences(db, id);
    assert.equal(after.length, 1);
    assert.equal(after[0].id, before.id);
    db.close();
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

function verifyMissedOccurrenceIsSkipped() {
  const db = makeDb();
  try {
    const now = new Date(2026, 9, 23, 10, 0);
    const id = water(db, now);
    ensureBasicNeedsOccurrences(db, now);
    const [missed] = activeOccurrences(db, id);
    assert.equal(ensureBasicNeedsOccurrences(db, new Date(2026, 9, 23, 10, 40)), 1);
    assert.equal(db.prepare('SELECT lifecycle_status FROM tasks WHERE id=?').get(missed.id).lifecycle_status, 'dismissed');
    assert.equal(activeOccurrences(db, id).length, 1);
  } finally { db.close(); }
}

function verifyCustomScheduleAndDeleteHistory() {
  const db = makeDb();
  try {
    const start = new Date(2026, 9, 25, 10, 0);
    const meal = listBasicNeedsReminders(db, start).find(item => item.template_key === 'meals');
    saveBasicReminder(db, { id: meal.id, title: meal.title, message: meal.message, intervalMinutes: null,
      startTime: '08:00', endTime: '20:00', activeDays: [1], enabled: true }, start);
    ensureBasicNeedsOccurrences(db, start);
    const [next] = activeOccurrences(db, meal.id);
    assert.equal(new Date(next.scheduled_reminder_at).getTime(), new Date(2026, 9, 26, 8, 0).getTime());
    const due = claimDueTasks(db, next.scheduled_reminder_at).find(task => task.basic_reminder_id === meal.id);
    respondToTask(db, due.id, 'dismiss', new Date(2026, 9, 26, 8, 1));
    const historyBeforeDelete = db.prepare('SELECT COUNT(*) AS count FROM reminder_history WHERE task_id=?').get(due.id).count;
    assert.equal(deleteBasicReminder(db, meal.id, new Date(2026, 9, 26, 8, 2)), true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM basic_reminders WHERE id=?').get(meal.id).count, 0);
    assert.equal(db.prepare('SELECT basic_reminder_id FROM tasks WHERE id=?').get(due.id).basic_reminder_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reminder_history WHERE task_id=?').get(due.id).count, historyBeforeDelete);
  } finally { db.close(); }
}

function verifyLegacyDatabaseMigration() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-basic-migration-'));
  const file = path.join(folder, 'legacy.sqlite3');
  try {
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY,title TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',due_at TEXT,
      recurrence TEXT NOT NULL DEFAULT 'none',status TEXT NOT NULL DEFAULT 'pending',source TEXT NOT NULL DEFAULT 'local',
      google_event_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    )`);
    legacy.prepare(`INSERT INTO tasks(id,title,message,due_at,status,source,google_event_id,created_at,updated_at)
      VALUES('legacy-google','Class','Keep this imported reminder','2026-12-01T10:00:00.000Z','pending','google_calendar','event-legacy','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z')`).run();
    legacy.close();

    const migrated = makeDb(file);
    try {
      const columns = new Set(migrated.pragma('table_info(tasks)').map(column => column.name));
      assert.equal(columns.has('basic_reminder_id'), true);
      assert.equal(columns.has('basic_occurrence_key'), true);
      const row = migrated.prepare('SELECT title,source,google_event_id FROM tasks WHERE id=?').get('legacy-google');
      assert.deepEqual(row, { title: 'Class', source: 'google_calendar', google_event_id: 'event-legacy' });
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='basic_reminders'").get().count, 1);
    } finally { migrated.close(); }
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

verifyWaterCompletesAndRepeats();
verifyPauseResumeAndIntervalChange();
verifyRestartAndNoDuplicates();
verifyMissedOccurrenceIsSkipped();
verifyCustomScheduleAndDeleteHistory();
verifyLegacyDatabaseMigration();
process.stdout.write('Basic Needs SQLite verification passed (templates, repeat, completion, pause/resume, interval edits, restart, deduplication, missed occurrence, active weekdays, retained history, legacy migration).\n');
