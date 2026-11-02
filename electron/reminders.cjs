const crypto = require('node:crypto');

const LEGACY_STATUS = { scheduled: 'pending', snoozed: 'pending', due: 'reminded', notified: 'reminded', paused: 'pending', completed: 'completed', dismissed: 'dismissed', cancelled: 'dismissed', archived: 'completed' };

const BASIC_NEEDS_TEMPLATES = [
  { key: 'drink-water', title: 'Drink Water', message: 'Take a moment to drink some water.', interval: 30, enabled: true },
  { key: 'short-break', title: 'Take a Short Break', message: 'Step away and take a short break.', interval: 60 },
  { key: 'stretch', title: 'Stretch Your Body', message: 'Stand up and stretch your body.', interval: 60 },
  { key: 'rest-eyes', title: 'Rest Your Eyes', message: 'Look away from the screen and rest your eyes.', interval: 20 },
  { key: 'walk-around', title: 'Walk Around', message: 'Take a short walk around.', interval: 60 },
  { key: 'posture', title: 'Maintain Good Posture', message: 'Check your posture and sit comfortably.', interval: 45 },
  { key: 'meals', title: 'Have Your Meals', message: 'It may be time for a meal.', interval: null, start: '08:00', end: '20:00' },
  { key: 'sleep', title: 'Sleep Reminder', message: 'Start winding down for sleep.', interval: null, start: '22:00', end: '22:00' },
  { key: 'exercise', title: 'Exercise', message: 'Make time for some movement.', interval: null, start: '18:00', end: '18:00' },
  { key: 'custom', title: 'Custom Reminder', message: '', interval: 60 }
];

function seedBasicNeedsReminders(db, nowDate = new Date()) {
  const now = nowDate.toISOString();
  const insert = db.prepare(`INSERT INTO basic_reminders
    (id,template_key,title,message,interval_minutes,start_time,end_time,active_days,enabled,sound_enabled,speak_enabled,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'[0,1,2,3,4,5,6]',?,?,1,?,?) ON CONFLICT(template_key) DO NOTHING`);
  for (const item of BASIC_NEEDS_TEMPLATES) {
    insert.run(`basic-${item.key}`, item.key, item.title, item.message, item.interval, item.start || '09:00', item.end || '21:00', Number(Boolean(item.enabled)), 0, now, now);
  }
}

function parseClock(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function allowedDays(reminder) {
  try {
    const days = JSON.parse(reminder.active_days || '[]');
    return new Set(days.filter(day => Number.isInteger(day) && day >= 0 && day <= 6));
  } catch { return new Set(); }
}

function nextBasicOccurrence(reminder, afterDate = new Date()) {
  const startMinute = parseClock(reminder.start_time);
  const endMinute = parseClock(reminder.end_time);
  const days = allowedDays(reminder);
  if (startMinute === null || endMinute === null || !days.size) return null;
  const interval = reminder.interval_minutes == null ? null : Number(reminder.interval_minutes);
  if (interval !== null && (!Number.isInteger(interval) || interval < 1 || interval > 1440)) return null;
  for (let offset = -1; offset < 370; offset++) {
    const day = new Date(afterDate.getFullYear(), afterDate.getMonth(), afterDate.getDate() + offset);
    if (!days.has(day.getDay())) continue;
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(startMinute / 60), startMinute % 60);
    const crossesMidnight = endMinute < startMinute;
    const endDay = crossesMidnight ? new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1) : day;
    const end = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate(), Math.floor(endMinute / 60), endMinute % 60);
    const candidate = new Date(start);
    while (candidate <= end) {
      if (candidate > afterDate) return candidate;
      if (interval === null) break;
      candidate.setMinutes(candidate.getMinutes() + interval);
    }
  }
  return null;
}

function isInsideBasicSchedule(reminder, date) {
  const startMinute = parseClock(reminder.start_time);
  const endMinute = parseClock(reminder.end_time);
  if (startMinute === null || endMinute === null) return false;
  const currentMinute = date.getHours() * 60 + date.getMinutes();
  const days = allowedDays(reminder);
  if (endMinute >= startMinute) return days.has(date.getDay()) && currentMinute >= startMinute && currentMinute <= endMinute;
  if (currentMinute >= startMinute) return days.has(date.getDay());
  const previousDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
  return currentMinute <= endMinute && days.has(previousDay.getDay());
}

function validateBasicReminder(input) {
  if (!input || typeof input.title !== 'string' || !input.title.trim()) throw new Error('A reminder title is required.');
  if (parseClock(input.startTime) === null || parseClock(input.endTime) === null) throw new Error('Choose valid start and end times.');
  const days = [...new Set((Array.isArray(input.activeDays) ? input.activeDays : []).map(Number))];
  if (!days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('Select at least one active day.');
  const interval = input.intervalMinutes == null || input.intervalMinutes === '' ? null : Number(input.intervalMinutes);
  if (interval !== null && (!Number.isInteger(interval) || interval < 1 || interval > 1440)) throw new Error('The repeat interval must be between 1 and 1440 minutes.');
  return { title: input.title.trim(), message: String(input.message || '').trim(), interval, start: input.startTime, end: input.endTime, days, enabled: Boolean(input.enabled), sound: Boolean(input.soundEnabled), speak: input.speakEnabled !== false };
}

function saveBasicReminder(db, input, nowDate = new Date()) {
  const valid = validateBasicReminder(input);
  const now = nowDate.toISOString();
  const id = input.id || crypto.randomUUID();
  const current = input.id ? db.prepare('SELECT * FROM basic_reminders WHERE id=?').get(input.id) : null;
  if (input.id && !current) throw new Error('Basic reminder not found.');
  db.prepare(`INSERT INTO basic_reminders
    (id,template_key,title,message,interval_minutes,start_time,end_time,active_days,enabled,sound_enabled,speak_enabled,created_at,updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,message=excluded.message,interval_minutes=excluded.interval_minutes,
      start_time=excluded.start_time,end_time=excluded.end_time,active_days=excluded.active_days,enabled=excluded.enabled,
      sound_enabled=excluded.sound_enabled,speak_enabled=excluded.speak_enabled,updated_at=excluded.updated_at`)
    .run(id, current?.template_key || null, valid.title, valid.message, valid.interval, valid.start, valid.end, JSON.stringify(valid.days), Number(valid.enabled), Number(valid.sound), Number(valid.speak), current?.created_at || now, now);
  db.prepare(`UPDATE tasks SET lifecycle_status='cancelled',status='dismissed',updated_at=?
    WHERE basic_reminder_id=? AND lifecycle_status IN ('scheduled','snoozed','due','notified','paused')`).run(now, id);
  return db.prepare('SELECT * FROM basic_reminders WHERE id=?').get(id);
}

function setBasicReminderEnabled(db, id, enabled, nowDate = new Date()) {
  const now = nowDate.toISOString();
  const reminder = db.prepare('SELECT * FROM basic_reminders WHERE id=?').get(id);
  if (!reminder) throw new Error('Basic reminder not found.');
  db.prepare('UPDATE basic_reminders SET enabled=?,updated_at=? WHERE id=?').run(Number(Boolean(enabled)), now, id);
  if (!enabled) {
    db.prepare(`UPDATE tasks SET lifecycle_status='paused',status='pending',updated_at=?
      WHERE basic_reminder_id=? AND lifecycle_status IN ('scheduled','snoozed','due','notified')`).run(now, id);
  } else {
    db.prepare(`UPDATE tasks SET lifecycle_status=CASE WHEN scheduled_reminder_at > ? THEN 'scheduled' ELSE 'cancelled' END,
      status=CASE WHEN scheduled_reminder_at > ? THEN 'pending' ELSE 'dismissed' END,snooze_until=NULL,updated_at=?
      WHERE basic_reminder_id=? AND lifecycle_status='paused'`).run(now, now, now, id);
  }
  return db.prepare('SELECT * FROM basic_reminders WHERE id=?').get(id);
}

function deleteBasicReminder(db, id, nowDate = new Date()) {
  const now = nowDate.toISOString();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE tasks SET lifecycle_status='cancelled',status='dismissed',updated_at=?
      WHERE basic_reminder_id=? AND lifecycle_status IN ('scheduled','snoozed','due','notified','paused')`).run(now, id);
    return db.prepare('DELETE FROM basic_reminders WHERE id=?').run(id).changes > 0;
  });
  return tx();
}

function ensureBasicNeedsOccurrences(db, nowDate = new Date(), missedHandling = 'skip') {
  const now = nowDate.toISOString();
  const staleBefore = new Date(nowDate.getTime() - 5 * 60 * 1000).toISOString();
  const tx = db.transaction(() => {
    const stale = missedHandling === 'skip'
      ? db.prepare(`SELECT id FROM tasks WHERE source='basic_needs' AND lifecycle_status='scheduled' AND scheduled_reminder_at < ?`).all(staleBefore)
      : [];
    for (const task of stale) {
      db.prepare(`UPDATE tasks SET lifecycle_status='dismissed',status='dismissed',updated_at=? WHERE id=? AND lifecycle_status='scheduled'`).run(now, task.id);
      db.prepare(`INSERT INTO reminder_history(task_id,event_type,response,occurred_at) VALUES(?,'skipped','missed',?)`).run(task.id, now);
    }
    const definitions = db.prepare('SELECT * FROM basic_reminders WHERE enabled=1').all();
    let created = 0;
    for (const reminder of definitions) {
      const active = db.prepare(`SELECT id FROM tasks WHERE basic_reminder_id=? AND lifecycle_status IN ('scheduled','snoozed','due','notified') LIMIT 1`).get(reminder.id);
      if (active) continue;
      const next = nextBasicOccurrence(reminder, nowDate);
      if (!next) continue;
      const dueAt = next.toISOString();
      const prior = db.prepare('SELECT id,lifecycle_status FROM tasks WHERE basic_reminder_id=? AND basic_occurrence_key=?').get(reminder.id, dueAt);
      if (prior) {
        db.prepare(`UPDATE tasks SET title=?,message=?,due_at=?,scheduled_reminder_at=?,snooze_until=NULL,
          status='pending',lifecycle_status='scheduled',updated_at=? WHERE id=? AND lifecycle_status IN ('cancelled','dismissed','paused')`)
          .run(reminder.title, reminder.message, dueAt, dueAt, now, prior.id);
        if (prior.lifecycle_status === 'cancelled' || prior.lifecycle_status === 'dismissed' || prior.lifecycle_status === 'paused') created++;
        continue;
      }
      const id = crypto.randomUUID();
      const result = db.prepare(`INSERT OR IGNORE INTO tasks
        (id,title,message,due_at,scheduled_reminder_at,recurrence,status,lifecycle_status,source,basic_reminder_id,basic_occurrence_key,created_at,updated_at)
        VALUES(?,?,?, ?, ?, 'basic_needs','pending','scheduled','basic_needs',?,?,?,?)`)
        .run(id, reminder.title, reminder.message, dueAt, dueAt, reminder.id, dueAt, now, now);
      created += result.changes;
    }
    return created;
  });
  return tx();
}

function listBasicNeedsReminders(db, nowDate = new Date()) {
  seedBasicNeedsReminders(db, nowDate);
  ensureBasicNeedsOccurrences(db, nowDate);
  return db.prepare(`SELECT basic_reminders.*,
    (SELECT scheduled_reminder_at FROM tasks WHERE basic_reminder_id=basic_reminders.id
      AND lifecycle_status IN ('scheduled','snoozed','due','notified') ORDER BY scheduled_reminder_at LIMIT 1) AS next_reminder_at
    FROM basic_reminders ORDER BY CASE WHEN template_key IS NULL THEN 1 ELSE 0 END, title COLLATE NOCASE`).all();
}

function createLocalTask(db, input, nowDate = new Date()) {
  if (!input || typeof input.title !== 'string' || !input.title.trim()) throw new Error('A task title is required.');
  const dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) throw new Error('The reminder date and time are invalid.');
  const recurrence = ['none', 'daily', 'weekly'].includes(input.recurrence) ? input.recurrence : 'none';
  if (recurrence !== 'none' && !dueAt) throw new Error('Recurring reminders need a date and time.');
  const now = nowDate.toISOString();
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO tasks
    (id,title,message,due_at,scheduled_reminder_at,recurrence,status,lifecycle_status,source,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'pending','scheduled','local',?,?)`)
    .run(id, input.title.trim(), input.message || '', dueAt?.toISOString() || null, dueAt?.toISOString() || null, recurrence, now, now);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function updateLocalTask(db, id, input, nowDate = new Date()) {
  if (!input || typeof input.title !== 'string' || !input.title.trim()) throw new Error('A task title is required.');
  const task = db.prepare("SELECT * FROM tasks WHERE id=? AND source='local'").get(id);
  if (!task) throw new Error('Local reminder not found.');
  const dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) throw new Error('The reminder date and time are invalid.');
  const recurrence = ['none', 'daily', 'weekly'].includes(input.recurrence) ? input.recurrence : 'none';
  if (recurrence !== 'none' && !dueAt) throw new Error('Recurring reminders need a date and time.');
  const scheduled = dueAt?.toISOString() || null;
  const now = nowDate.toISOString();
  db.prepare(`UPDATE tasks SET title=?,message=?,due_at=?,scheduled_reminder_at=?,recurrence=?,status='pending',
    lifecycle_status='scheduled',snooze_until=NULL,completed_at=NULL,expires_at=NULL,updated_at=? WHERE id=? AND source='local'`)
    .run(input.title.trim(), String(input.message || ''), scheduled, scheduled, recurrence, now, id);
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
}

function setLocalTaskEnabled(db, id, enabled, nowDate = new Date()) {
  const task = db.prepare("SELECT * FROM tasks WHERE id=? AND source='local'").get(id);
  if (!task) throw new Error('Local reminder not found.');
  const now = nowDate.toISOString();
  if (!enabled) {
    db.prepare("UPDATE tasks SET lifecycle_status='paused',status='pending',updated_at=? WHERE id=? AND source='local'").run(now, id);
  } else {
    let scheduled = task.scheduled_reminder_at || task.due_at;
    if (scheduled && new Date(scheduled) <= nowDate) {
      const next = new Date(scheduled);
      if (task.recurrence === 'daily' || task.recurrence === 'weekly') {
        const days = task.recurrence === 'weekly' ? 7 : 1;
        do { next.setDate(next.getDate() + days); } while (next <= nowDate);
        scheduled = next.toISOString();
      } else scheduled = now;
    }
    db.prepare("UPDATE tasks SET lifecycle_status='scheduled',status='pending',scheduled_reminder_at=?,due_at=?,snooze_until=NULL,updated_at=? WHERE id=? AND source='local'")
      .run(scheduled, scheduled, now, id);
  }
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
}

function deleteLocalTask(db, id, nowDate = new Date()) {
  const result = db.prepare("UPDATE tasks SET lifecycle_status='cancelled',status='dismissed',updated_at=? WHERE id=? AND source='local'")
    .run(nowDate.toISOString(), id);
  return result.changes > 0;
}

function nextLocalRecurrence(task, nowDate) {
  const sourceTime = task.scheduled_reminder_at || task.due_at;
  if (!sourceTime || !['daily', 'weekly'].includes(task.recurrence)) return null;
  const next = new Date(sourceTime);
  const days = task.recurrence === 'weekly' ? 7 : 1;
  do { next.setDate(next.getDate() + days); } while (next <= nowDate);
  return next.toISOString();
}

function claimDueTasks(db, now = new Date().toISOString(), limit = 30) {
  const transaction = db.transaction(() => {
    const due = db.prepare(`SELECT * FROM tasks
      WHERE lifecycle_status IN ('scheduled','snoozed','due')
        AND scheduled_reminder_at IS NOT NULL AND scheduled_reminder_at <= ?
        AND (source != 'basic_needs' OR EXISTS (SELECT 1 FROM basic_reminders WHERE basic_reminders.id=tasks.basic_reminder_id AND basic_reminders.enabled=1))
        AND (source != 'google_calendar' OR event_status IS NULL OR event_status = 'confirmed')
      ORDER BY scheduled_reminder_at ASC LIMIT ?`).all(now, limit);
    const markDue = db.prepare(`UPDATE tasks SET lifecycle_status='due' WHERE id=? AND lifecycle_status IN ('scheduled','snoozed','due')`);
    const update = db.prepare(`UPDATE tasks SET lifecycle_status='notified', status='reminded',
      last_notified_occurrence=scheduled_reminder_at, last_notified_at=?, updated_at=?
      WHERE id=? AND lifecycle_status IN ('scheduled','snoozed','due')`);
    const history = db.prepare(`INSERT INTO reminder_history(task_id,event_type,response,occurred_at) VALUES(?,'fired',NULL,?)`);
    const claimed = [];
    for (const task of due) {
      markDue.run(task.id);
      const changed = update.run(now, now, task.id).changes;
      if (!changed) continue;
      history.run(task.id, now);
      claimed.push(task.basic_reminder_id
        ? db.prepare(`SELECT tasks.*, basic_reminders.sound_enabled, basic_reminders.speak_enabled
          FROM tasks LEFT JOIN basic_reminders ON basic_reminders.id=tasks.basic_reminder_id WHERE tasks.id=?`).get(task.id)
        : db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
    }
    return claimed;
  });
  return transaction();
}

function respondToTask(db, id, response, nowDate = new Date(), options = {}) {
  const allowed = new Set(['done', 'snooze', 'dismiss', 'no']);
  if (!allowed.has(response)) throw new Error('Unsupported response.');
  if (id === 'test') return { id, status: response === 'done' ? 'completed' : 'dismissed' };
  const now = nowDate.toISOString();
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!task) throw new Error('Task not found.');
  let lifecycle = task.lifecycle_status;
  let legacy = task.status;
  let scheduled = task.scheduled_reminder_at;
  let snooze = null, completed = task.completed_at, expires = task.expires_at;
  if (response === 'done') {
    const next = task.source === 'local' ? nextLocalRecurrence(task, nowDate) : null;
    if (next) { lifecycle = 'scheduled'; legacy = 'pending'; scheduled = next; completed = null; expires = null; }
    else { lifecycle = 'completed'; legacy = 'completed'; completed = now; expires = new Date(nowDate.getTime() + 60 * 60 * 1000).toISOString(); }
  } else if (response === 'snooze') {
    lifecycle = 'snoozed'; legacy = 'pending';
    const snoozeMinutes = Math.min(240, Math.max(1, Number(options.snoozeMinutes) || 30));
    let snoozeDate = new Date(nowDate.getTime() + snoozeMinutes * 60 * 1000);
    if (task.basic_reminder_id) {
      const reminder = db.prepare('SELECT * FROM basic_reminders WHERE id=?').get(task.basic_reminder_id);
      if (reminder && !isInsideBasicSchedule(reminder, snoozeDate)) {
        const next = nextBasicOccurrence(reminder, new Date(snoozeDate.getTime() - 1));
        if (next) snoozeDate = next;
      }
    }
    snooze = snoozeDate.toISOString(); scheduled = snooze;
  } else {
    const next = task.source === 'local' ? nextLocalRecurrence(task, nowDate) : null;
    if (next) { lifecycle = 'scheduled'; legacy = 'pending'; scheduled = next; }
    else { lifecycle = 'dismissed'; legacy = 'dismissed'; }
  }
  const tx = db.transaction(() => {
    db.prepare(`UPDATE tasks SET lifecycle_status=?,status=?,scheduled_reminder_at=?,due_at=?,snooze_until=?,completed_at=?,expires_at=?,updated_at=? WHERE id=?`)
      .run(lifecycle, legacy, scheduled, response === 'snooze' ? scheduled : task.due_at, snooze, completed, expires, now, id);
    db.prepare(`INSERT INTO reminder_history(task_id,event_type,response,occurred_at) VALUES(?,'response',?,?)`).run(id, response, now);
  });
  tx();
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
}

function archiveExpiredCompleted(db, now = new Date().toISOString()) {
  return db.prepare(`UPDATE tasks SET lifecycle_status='archived',archived_at=?,updated_at=?
    WHERE lifecycle_status='completed' AND expires_at IS NOT NULL AND expires_at <= ?`).run(now, now, now).changes;
}

module.exports = {
  createLocalTask, updateLocalTask, setLocalTaskEnabled, deleteLocalTask,
  claimDueTasks, respondToTask, archiveExpiredCompleted,
  seedBasicNeedsReminders, nextBasicOccurrence, saveBasicReminder, setBasicReminderEnabled,
  deleteBasicReminder, ensureBasicNeedsOccurrences, listBasicNeedsReminders
};
