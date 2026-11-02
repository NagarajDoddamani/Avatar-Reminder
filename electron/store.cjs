const Database = require('better-sqlite3');

function openDatabase(filePath) {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      due_at TEXT,
      recurrence TEXT NOT NULL DEFAULT 'none',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','reminded','completed','dismissed')),
      lifecycle_status TEXT NOT NULL DEFAULT 'scheduled',
      source TEXT NOT NULL DEFAULT 'local',
      google_event_id TEXT,
      calendar_id TEXT,
      event_start_at TEXT,
      event_end_at TEXT,
      event_timezone TEXT,
      event_status TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      recurrence_json TEXT NOT NULL DEFAULT '[]',
      scheduled_reminder_at TEXT,
      last_notified_at TEXT,
      last_notified_occurrence TEXT,
      snooze_until TEXT,
      completed_at TEXT,
      expires_at TEXT,
      archived_at TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_due_status
      ON tasks(status, due_at);

    CREATE TABLE IF NOT EXISTS reminder_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      response TEXT,
      occurred_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      external_id TEXT,
      sync_status TEXT NOT NULL,
      error_message TEXT,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      calendar_id TEXT NOT NULL,
      google_event_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '(Untitled event)',
      description TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      start_at TEXT,
      end_at TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      recurrence_json TEXT NOT NULL DEFAULT '[]',
      recurring_event_id TEXT,
      original_start_at TEXT,
      event_timezone TEXT,
      event_status TEXT NOT NULL DEFAULT 'confirmed',
      event_type TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(calendar_id, google_event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_at);
    CREATE TABLE IF NOT EXISTS calendar_sync_state (
      calendar_id TEXT PRIMARY KEY,
      sync_token TEXT NOT NULL,
      last_synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS basic_reminders (
      id TEXT PRIMARY KEY,
      template_key TEXT UNIQUE,
      title TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      interval_minutes INTEGER,
      start_time TEXT NOT NULL DEFAULT '09:00',
      end_time TEXT NOT NULL DEFAULT '21:00',
      active_days TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      sound_enabled INTEGER NOT NULL DEFAULT 0 CHECK(sound_enabled IN (0,1)),
      speak_enabled INTEGER NOT NULL DEFAULT 1 CHECK(speak_enabled IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Add lifecycle columns safely to databases created by earlier versions.
  const taskColumns = new Set(db.pragma('table_info(tasks)').map(column => column.name));
  const additions = {
    lifecycle_status: "TEXT NOT NULL DEFAULT 'scheduled'",
    calendar_id: 'TEXT', event_start_at: 'TEXT', event_end_at: 'TEXT', event_timezone: 'TEXT',
    event_status: 'TEXT', all_day: 'INTEGER NOT NULL DEFAULT 0', recurrence_json: "TEXT NOT NULL DEFAULT '[]'",
    scheduled_reminder_at: 'TEXT', last_notified_at: 'TEXT', last_notified_occurrence: 'TEXT', snooze_until: 'TEXT',
    completed_at: 'TEXT', expires_at: 'TEXT', archived_at: 'TEXT', last_synced_at: 'TEXT'
  };
  for (const [column, definition] of Object.entries(additions)) {
    if (!taskColumns.has(column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
  }
  if (!taskColumns.has('basic_reminder_id')) db.exec('ALTER TABLE tasks ADD COLUMN basic_reminder_id TEXT REFERENCES basic_reminders(id) ON DELETE SET NULL');
  if (!taskColumns.has('basic_occurrence_key')) db.exec('ALTER TABLE tasks ADD COLUMN basic_occurrence_key TEXT');
  const eventColumns = new Set(db.pragma('table_info(calendar_events)').map(column => column.name));
  if (!eventColumns.has('event_timezone')) db.exec('ALTER TABLE calendar_events ADD COLUMN event_timezone TEXT');
  db.exec(`
    UPDATE tasks SET
      lifecycle_status = CASE status WHEN 'reminded' THEN 'notified' WHEN 'completed' THEN 'completed' WHEN 'dismissed' THEN 'dismissed' ELSE lifecycle_status END,
      scheduled_reminder_at = COALESCE(scheduled_reminder_at, due_at),
      last_notified_at = CASE WHEN status='reminded' THEN COALESCE(last_notified_at,updated_at) ELSE last_notified_at END,
      last_notified_occurrence = CASE WHEN status='reminded' THEN COALESCE(last_notified_occurrence,due_at) ELSE last_notified_occurrence END,
      completed_at = CASE WHEN status='completed' THEN COALESCE(completed_at,updated_at) ELSE completed_at END,
      expires_at = CASE WHEN status='completed' THEN COALESCE(expires_at,strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+1 hour')) ELSE expires_at END
    WHERE lifecycle_status = 'scheduled';
    CREATE INDEX IF NOT EXISTS idx_tasks_lifecycle_due ON tasks(lifecycle_status, scheduled_reminder_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_external ON tasks(calendar_id, google_event_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_basic_occurrence ON tasks(basic_reminder_id, basic_occurrence_key) WHERE basic_reminder_id IS NOT NULL AND basic_occurrence_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_basic_active ON tasks(basic_reminder_id, lifecycle_status, scheduled_reminder_at);
  `);
  return db;
}

module.exports = { openDatabase };
