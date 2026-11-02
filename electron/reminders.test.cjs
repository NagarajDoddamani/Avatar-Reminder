const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalTask, claimDueTasks, respondToTask, archiveExpiredCompleted } = require('./reminders.cjs');

function memoryDb() {
  const rows = new Map();
  const db = {
    prepare(sql) {
      if (sql.includes('INSERT INTO tasks')) return { run: (id,title,message,due,scheduled,recurrence,now1,now2) => { rows.set(id,{id,title,message,due_at:due,scheduled_reminder_at:scheduled,recurrence,status:'pending',lifecycle_status:'scheduled',source:'local',created_at:now1,updated_at:now2}); } };
      if (sql.includes('SELECT * FROM tasks WHERE id')) return { get: id => rows.get(id) };
      if (sql.includes('SELECT * FROM tasks') && sql.includes('lifecycle_status IN')) return { all: (now,limit) => [...rows.values()].filter(row=>['scheduled','snoozed','due'].includes(row.lifecycle_status)&&row.scheduled_reminder_at&&row.scheduled_reminder_at<=now&&(row.source!=='google_calendar'||row.event_status==null||row.event_status==='confirmed')).sort((a,b)=>a.scheduled_reminder_at.localeCompare(b.scheduled_reminder_at)).slice(0,limit) };
      if (sql.includes("UPDATE tasks SET lifecycle_status='due'")) return { run: id => { const row=rows.get(id);if(row)row.lifecycle_status='due'; } };
      if (sql.includes("UPDATE tasks SET lifecycle_status='notified'")) return { run: (now,updated,id) => { const row=rows.get(id); if(!row||!['scheduled','snoozed','due'].includes(row.lifecycle_status))return{changes:0}; Object.assign(row,{lifecycle_status:'notified',status:'reminded',last_notified_occurrence:row.scheduled_reminder_at,last_notified_at:now,updated_at:updated});return{changes:1}; } };
      if (sql.includes("INSERT INTO reminder_history")) return { run: () => ({ changes: 1 }) };
      if (sql.includes('UPDATE tasks SET lifecycle_status=?,status=?,scheduled_reminder_at=?')) return { run: (lifecycle,status,scheduled,due,snooze,completed,expires,updated,id) => { Object.assign(rows.get(id),{lifecycle_status:lifecycle,status,scheduled_reminder_at:scheduled,due_at:due,snooze_until:snooze,completed_at:completed,expires_at:expires,updated_at:updated}); } };
      if (sql.includes("UPDATE tasks SET lifecycle_status='archived'")) return { run: (now1,now2,now3) => { let changes=0;for(const row of rows.values()){if(row.lifecycle_status==='completed'&&row.expires_at&&row.expires_at<=now3){Object.assign(row,{lifecycle_status:'archived',archived_at:now1,updated_at:now2});changes++;}}return{changes}; } };
      if (sql.includes('SELECT COUNT(*) AS count FROM tasks')) return { get: id => ({count:rows.has(id)?1:0}) };
      throw new Error(`Unmocked reminder query: ${sql}`);
    },
    transaction(fn) { return (...args) => fn(...args); }
  };
  return { db, rows };
}

test('local reminder lifecycle notifies once, snoozes, completes, and archives an hour later', () => {
  const { db, rows } = memoryDb();
  const task = createLocalTask(db,{title:'Study',dueAt:'2026-10-23T10:01:00.000Z'},new Date('2026-10-23T10:00:00.000Z'));
  const first=claimDueTasks(db,'2026-10-23T10:02:00.000Z');
  assert.equal(first.length,1);assert.equal(first[0].lifecycle_status,'notified');
  assert.equal(claimDueTasks(db,'2026-10-23T10:03:00.000Z').length,0);
  const snoozed=respondToTask(db,task.id,'snooze',new Date('2026-10-23T10:04:00.000Z'));
  assert.equal(snoozed.lifecycle_status,'snoozed');assert.equal(snoozed.scheduled_reminder_at,'2026-10-23T10:34:00.000Z');
  assert.equal(claimDueTasks(db,'2026-10-23T10:34:01.000Z').length,1);
  const completed=respondToTask(db,task.id,'done',new Date('2026-10-23T10:35:00.000Z'));
  assert.equal(completed.lifecycle_status,'completed');assert.equal(completed.expires_at,'2026-10-23T11:35:00.000Z');
  assert.equal(archiveExpiredCompleted(db,'2026-10-23T11:34:59.000Z'),0);
  assert.equal(archiveExpiredCompleted(db,'2026-10-23T11:35:01.000Z'),1);
  assert.equal(rows.get(task.id).lifecycle_status,'archived');
});

test('dismissed tasks remain accessible and are not notified again', () => {
  const {db,rows}=memoryDb();
  const task=createLocalTask(db,{title:'Call home',dueAt:'2026-10-23T10:00:00.000Z'},new Date('2026-10-23T09:00:00.000Z'));
  claimDueTasks(db,'2026-10-23T10:01:00.000Z');
  const dismissed=respondToTask(db,task.id,'dismiss',new Date('2026-10-23T10:02:00.000Z'));
  assert.equal(dismissed.lifecycle_status,'dismissed');assert.equal(rows.has(task.id),true);
  assert.equal(claimDueTasks(db,'2026-10-24T10:00:00.000Z').length,0);
});

test('the same scheduler claims imported calendar reminders and skips cancelled events', () => {
  const {db,rows}=memoryDb();
  rows.set('calendar-event',{id:'calendar-event',title:'Lecture',message:'Lecture starts now',source:'google_calendar',event_status:'confirmed',lifecycle_status:'scheduled',scheduled_reminder_at:'2026-10-23T10:00:00.000Z',status:'pending'});
  rows.set('cancelled-event',{id:'cancelled-event',title:'Cancelled',message:'',source:'google_calendar',event_status:'cancelled',lifecycle_status:'cancelled',scheduled_reminder_at:'2026-10-23T10:00:00.000Z',status:'dismissed'});
  const claimed=claimDueTasks(db,'2026-10-23T10:01:00.000Z');
  assert.deepEqual(claimed.map(task=>task.id),['calendar-event']);
  assert.equal(rows.get('calendar-event').lifecycle_status,'notified');
  assert.equal(rows.get('cancelled-event').lifecycle_status,'cancelled');
});
