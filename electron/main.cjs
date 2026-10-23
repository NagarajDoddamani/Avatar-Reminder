const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, shell, safeStorage } = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { openDatabase } = require('./store.cjs');
const { createCalendarService } = require('./calendar.cjs');

let mainWindow;
let tray;
let db;
let calendar;
let reminderTimer;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 560,
    minWidth: 360,
    minHeight: 420,
    show: true,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (!app.isPackaged) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showReminder(task) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.webContents.send('reminder:fire', task);
  }
  if (Notification.isSupported()) {
    new Notification({ title: task.title, body: task.message || 'Your reminder is due.' }).show();
  }
}

function scheduleLoop() {
  clearInterval(reminderTimer);
  // Poll each 15 seconds; SQLite is the source of truth.
  reminderTimer = setInterval(() => {
    const now = new Date().toISOString();
    const due = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'pending' AND due_at IS NOT NULL AND due_at <= ?
      ORDER BY due_at ASC LIMIT 20
    `).all(now);

    for (const task of due) {
      // Mark as fired before showing, preventing duplicate firing after app restart.
      db.prepare("UPDATE tasks SET status = 'reminded', updated_at = ? WHERE id = ?")
        .run(now, task.id);
      db.prepare(`
        INSERT INTO reminder_history(task_id, event_type, response, occurred_at)
        VALUES (?, 'fired', NULL, ?)
      `).run(task.id, now);
      showReminder(task);
    }
  }, 15000);
}

function registerIpc() {
  ipcMain.handle('tasks:list', () => db.prepare(`
    SELECT * FROM tasks ORDER BY
      CASE status WHEN 'pending' THEN 0 WHEN 'reminded' THEN 1 ELSE 2 END,
      due_at ASC
  `).all());

  ipcMain.handle('tasks:create', (_event, input) => {
    if (!input || typeof input.title !== 'string' || !input.title.trim()) {
      throw new Error('A task title is required.');
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const dueAt = input.dueAt ? new Date(input.dueAt).toISOString() : null;
    db.prepare(`
      INSERT INTO tasks(id, title, message, due_at, recurrence, status, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(id, input.title.trim(), input.message || '', dueAt, input.recurrence || 'none',
      input.source || 'local', now, now);
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  });

  ipcMain.handle('tasks:respond', (_event, { id, response }) => {
    const allowed = new Set(['done', 'snooze', 'dismiss', 'no']);
    if (!allowed.has(response)) throw new Error('Unsupported response.');
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!task) throw new Error('Task not found.');
    const now = new Date();
    let status = task.status;
    let dueAt = task.due_at;

    if (response === 'done') status = 'completed';
    else if (response === 'snooze') {
      status = 'pending';
      dueAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    } else if (response === 'dismiss' || response === 'no') status = 'dismissed';

    db.prepare('UPDATE tasks SET status = ?, due_at = ?, updated_at = ? WHERE id = ?')
      .run(status, dueAt, now.toISOString(), id);
    db.prepare(`
      INSERT INTO reminder_history(task_id, event_type, response, occurred_at)
      VALUES (?, 'response', ?, ?)
    `).run(id, response, now.toISOString());
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  });

  ipcMain.handle('calendar:status', () => calendar.status());
  ipcMain.handle('calendar:connect', async () => calendar.connect());
  ipcMain.handle('calendar:upcoming', async () => calendar.listUpcoming());
  ipcMain.handle('calendar:create-event', async (_event, taskId) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task || !task.due_at) throw new Error('Task needs a due date before syncing.');
    const result = await calendar.createEvent(task);
    const now = new Date().toISOString();
    db.prepare('UPDATE tasks SET google_event_id = ?, updated_at = ? WHERE id = ?')
      .run(result.id, now, taskId);
    db.prepare(`
      INSERT INTO sync_log(task_id, provider, external_id, sync_status, synced_at)
      VALUES (?, 'google_calendar', ?, 'synced', ?)
    `).run(taskId, result.id, now);
    return result;
  });

  ipcMain.handle('window:hide', () => mainWindow.hide());
  ipcMain.handle('window:show', () => mainWindow.show());
  ipcMain.handle('app:open-external', async (_event, url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Only HTTPS links are allowed.');
    await shell.openExternal(parsed.toString());
  });
}

app.whenReady().then(() => {
  db = openDatabase(path.join(app.getPath('userData'), 'avatar-reminder.sqlite3'));
  calendar = createCalendarService({
    app,
    db,
    safeStorage,
    credentialsPath: path.join(app.getPath('userData'), 'google-credentials.json')
  });
  createWindow();
  registerIpc();
  scheduleLoop();

  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Avatar Reminder');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show reminder', click: () => mainWindow.show() },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow.show();
});
app.on('before-quit', () => { app.isQuitting = true; clearInterval(reminderTimer); });
app.on('window-all-closed', (event) => { /* Keep tray app running on Windows. */ });
