const crypto = require('node:crypto');

const LEGACY_STATUS = { scheduled: 'pending', snoozed: 'pending', due: 'reminded', notified: 'reminded', completed: 'completed', dismissed: 'dismissed', cancelled: 'dismissed', archived: 'completed' };

function createLocalTask(db, input, nowDate = new Date()) {
  if (!input || typeof input.title !== 'string' || !input.title.trim()) throw new Error('A task title is required.');
  const dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) throw new Error('The reminder date and time are invalid.');
  const now = nowDate.toISOString();
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO tasks
    (id,title,message,due_at,scheduled_reminder_at,recurrence,status,lifecycle_status,source,created_at,updated_at)
    VALUES(?,?,?,?,?,'none','pending','scheduled',?,?,?)`)
    .run(id, input.title.trim(), input.message || '', dueAt?.toISOString() || null, dueAt?.toISOString() || null, input.source || 'local', now, now);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function claimDueTasks(db, now = new Date().toISOString(), limit = 30) {
  const transaction = db.transaction(() => {
    const due = db.prepare(`SELECT * FROM tasks
      WHERE lifecycle_status IN ('scheduled','snoozed','due')
        AND scheduled_reminder_at IS NOT NULL AND scheduled_reminder_at <= ?
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
      claimed.push(db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
    }
    return claimed;
  });
  return transaction();
}

function respondToTask(db, id, response, nowDate = new Date()) {
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
    lifecycle = 'completed'; legacy = 'completed'; completed = now;
    expires = new Date(nowDate.getTime() + 60 * 60 * 1000).toISOString();
  } else if (response === 'snooze') {
    lifecycle = 'snoozed'; legacy = 'pending';
    snooze = new Date(nowDate.getTime() + 30 * 60 * 1000).toISOString(); scheduled = snooze;
  } else {
    lifecycle = 'dismissed'; legacy = 'dismissed';
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

module.exports = { createLocalTask, claimDueTasks, respondToTask, archiveExpiredCompleted };
