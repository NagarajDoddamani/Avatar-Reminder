const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, shell, safeStorage, powerMonitor, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { screen } = require('electron');
const { openDatabase } = require('./store.cjs');
const { createCalendarService } = require('./calendar.cjs');
const {
  createLocalTask, claimDueTasks, respondToTask, archiveExpiredCompleted,
  seedBasicNeedsReminders, ensureBasicNeedsOccurrences, listBasicNeedsReminders,
  saveBasicReminder, setBasicReminderEnabled, deleteBasicReminder
} = require('./reminders.cjs');

let mainWindow;
let avatarWindow;
let tray;
let db;
let calendar;
let reminderTimer;
let calendarSyncTimer;
let onlineMonitorTimer;
let wasOnline = true;
let reminderQueue = [];
let currentReminderId = null;
let overlayLoaded = false;
let calendarSyncInProgress = false;
let avatarWalkTimer;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 360,
    minHeight: 420,
    show: true,
    frame: true,
    transparent: false,
    alwaysOnTop: false,
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

function createAvatarWindow() {
  avatarWindow = new BrowserWindow({
    width: 500, height: 370, frame: false, transparent: true,
    alwaysOnTop: true, show: false, resizable: false, skipTaskbar: true,
    focusable: true, hasShadow: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const url = !app.isPackaged ? 'http://127.0.0.1:5173/#avatar' : `${pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href}#avatar`;
  avatarWindow.loadURL(url);
  avatarWindow.webContents.once('did-finish-load', () => {
    overlayLoaded = true;
    displayNextReminder();
  });
  avatarWindow.setAlwaysOnTop(true, 'screen-saver');
}

function displayNextReminder() {
  if (!overlayLoaded || !avatarWindow || avatarWindow.isDestroyed() || !reminderQueue.length || avatarWindow.isVisible()) return;
  const task = reminderQueue.shift();
  currentReminderId = task.id;
  walkAvatar(task);
}

function pruneCancelledReminders() {
  const cancelled = new Set(db.prepare("SELECT id FROM tasks WHERE lifecycle_status='cancelled'").all().map(row => row.id));
  reminderQueue = reminderQueue.filter(task => !cancelled.has(task.id));
  if (currentReminderId && cancelled.has(currentReminderId)) {
    currentReminderId = null;
    if (avatarWindow && !avatarWindow.isDestroyed()) avatarWindow.hide();
    setTimeout(displayNextReminder, 100);
  }
}

function walkAvatar(task) {
  if (!avatarWindow || avatarWindow.isDestroyed()) createAvatarWindow();
  const area = screen.getPrimaryDisplay().workArea;
  const y = area.y + Math.max(20, area.height - 390);
  const from = area.x + area.width;
  const to = area.x + Math.round((area.width - 500) / 2);
  avatarWindow.setPosition(from, y); avatarWindow.showInactive(); avatarWindow.setAlwaysOnTop(true, 'screen-saver');
  avatarWindow.webContents.send('reminder:fire', task);
  let x = from;
  clearInterval(avatarWalkTimer);
  avatarWalkTimer = setInterval(() => {
    if (!avatarWindow || avatarWindow.isDestroyed()) { clearInterval(avatarWalkTimer); avatarWalkTimer = null; return; }
    if (currentReminderId !== task.id) { clearInterval(avatarWalkTimer); avatarWalkTimer = null; return; }
    x = Math.max(to, x - 8); avatarWindow.setPosition(x, y);
    if (x <= to) {
      clearInterval(avatarWalkTimer);
      avatarWalkTimer = null;
      avatarWindow.webContents.send('reminder:arrived', task.id);
    }
  }, 16);
}

function walkOverlayOffScreen() {
  if (!avatarWindow || avatarWindow.isDestroyed() || !avatarWindow.isVisible()) return Promise.resolve(false);
  const area = screen.getPrimaryDisplay().workArea;
  const [startX, y] = avatarWindow.getPosition();
  const targetX = area.x + area.width;
  let x = startX;
  clearInterval(avatarWalkTimer);
  return new Promise(resolve => {
    avatarWalkTimer = setInterval(() => {
      if (!avatarWindow || avatarWindow.isDestroyed()) {
        clearInterval(avatarWalkTimer); avatarWalkTimer = null; resolve(false); return;
      }
      x = Math.min(targetX, x + 8);
      avatarWindow.setPosition(x, y);
      if (x >= targetX) {
        clearInterval(avatarWalkTimer); avatarWalkTimer = null; resolve(true);
      }
    }, 16);
  });
}

function showReminder(task) {
  if (task.id === currentReminderId || reminderQueue.some(item => item.id === task.id)) return;
  reminderQueue.push(task);
  if (overlayLoaded && avatarWindow && !avatarWindow.isVisible()) displayNextReminder();
  if (Notification.isSupported()) {
    new Notification({ title: task.title, body: task.message || 'Your reminder is due.' }).show();
  }
}

function isQuietHours(nowDate = new Date()) {
  const startQuiet = setting('quietStart', ''), endQuiet = setting('quietEnd', '');
  if (!startQuiet || !endQuiet) return false;
  const minute = nowDate.getHours() * 60 + nowDate.getMinutes();
  const [sh, sm] = startQuiet.split(':').map(Number), [eh, em] = endQuiet.split(':').map(Number);
  if ([sh, sm, eh, em].some(Number.isNaN)) return false;
  const start = sh * 60 + sm, end = eh * 60 + em;
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
}

function scheduleLoop() {
  clearInterval(reminderTimer);
  // Poll each 15 seconds; SQLite is the source of truth.
  reminderTimer = setInterval(() => {
    const archived = archiveExpiredCompleted(db);
    if (archived && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
    ensureBasicNeedsOccurrences(db);
    if (isQuietHours()) return;
    const now = new Date().toISOString();
    const claimed = claimDueTasks(db, now);
    for (const task of claimed) showReminder(task);
    if (claimed.length && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
  }, 15000);
  const archived = archiveExpiredCompleted(db);
  ensureBasicNeedsOccurrences(db);
  const claimed = isQuietHours() ? [] : claimDueTasks(db);
  for (const task of claimed) showReminder(task);
  if (claimed.length && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
  else if (archived && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
}

function setting(key, fallback) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  try { return row ? JSON.parse(row.value) : fallback; } catch { return fallback; }
}

async function syncSelectedCalendars(reason) {
  if (!calendar || calendarSyncInProgress || !calendar.status().connected) return;
  const ids = setting('calendarIds', ['primary']);
  if (!Array.isArray(ids) || !ids.length) return;
  calendarSyncInProgress = true;
  try {
    const result = await calendar.syncCalendars({ calendarIds: ids, incremental: true });
    pruneCancelledReminders();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
    console.info('[calendar-auto-sync]', JSON.stringify({ reason, ...result, errors: result.errors.map(({ calendarId, status }) => ({ calendarId, status })) }));
  } catch (error) {
    console.error('[calendar-auto-sync]', JSON.stringify({ reason, error: String(error?.message || 'Sync failed').slice(0, 220) }));
  } finally { calendarSyncInProgress = false; }
}

function registerIpc() {
  ipcMain.handle('tasks:list', () => db.prepare(`SELECT * FROM tasks
    ORDER BY CASE lifecycle_status WHEN 'scheduled' THEN 0 WHEN 'snoozed' THEN 1 WHEN 'notified' THEN 2 WHEN 'due' THEN 2 ELSE 3 END,
    scheduled_reminder_at ASC, created_at DESC`).all());
  ipcMain.handle('tasks:create', (_event, input) => createLocalTask(db, input));
  ipcMain.handle('basic-needs:list', () => listBasicNeedsReminders(db));
  ipcMain.handle('basic-needs:save', (_event, input) => {
    const reminder = saveBasicReminder(db, input);
    ensureBasicNeedsOccurrences(db);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
    return reminder;
  });
  ipcMain.handle('basic-needs:enabled', (_event, { id, enabled }) => {
    const reminder = setBasicReminderEnabled(db, id, enabled);
    ensureBasicNeedsOccurrences(db);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
    return reminder;
  });
  ipcMain.handle('basic-needs:delete', (_event, id) => {
    const deleted = deleteBasicReminder(db, id);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
    return deleted;
  });
  ipcMain.handle('tasks:respond', (_event, { id, response }) => {
    const updated = id === 'test' ? { id, lifecycle_status: response } : respondToTask(db, id, response);
    ensureBasicNeedsOccurrences(db);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
    const wasCurrent = currentReminderId === id;
    reminderQueue = reminderQueue.filter(task => task.id !== id);
    if (!wasCurrent && !currentReminderId) setTimeout(displayNextReminder, 100);
    return updated;
  });

  ipcMain.handle('calendar:status', () => calendar.status());
  ipcMain.handle('calendar:connect', async () => { const result = await calendar.connect(); await syncSelectedCalendars('connected'); return result; });
  ipcMain.handle('calendar:list', async () => calendar.listCalendars());
  ipcMain.handle('calendar:events-local', () => calendar.getImportedEvents());
  ipcMain.handle('calendar:sync', async (_event, options) => {
    const safeOptions = options || {};
    db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('calendarIds',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(JSON.stringify(safeOptions.calendarIds || []), new Date().toISOString());
    db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('calendarSyncRange',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(JSON.stringify({ timeMin: safeOptions.timeMin || null, timeMax: safeOptions.timeMax || null }), new Date().toISOString());
    const result = await calendar.syncCalendars(safeOptions);
    pruneCancelledReminders();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
    return result;
  });
  ipcMain.handle('calendar:create-event', async (_event, taskId) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task || !task.due_at) throw new Error('Task needs a due date before syncing.');
    if (task.source === 'google_calendar') throw new Error('Calendar-imported reminders are already linked to Google Calendar.');
    const result = await calendar.createEvent(task);
    const now = new Date().toISOString();
    db.prepare("UPDATE tasks SET google_event_id = ?, calendar_id = 'primary', updated_at = ? WHERE id = ?")
      .run(result.id, now, taskId);
    db.prepare(`
      INSERT INTO sync_log(task_id, provider, external_id, sync_status, synced_at)
      VALUES (?, 'google_calendar', ?, 'synced', ?)
    `).run(taskId, result.id, now);
    return result;
  });

  ipcMain.handle('window:hide', () => mainWindow.hide());
  ipcMain.handle('window:show', () => mainWindow.show());
  ipcMain.handle('overlay:dismiss', () => {
    clearInterval(avatarWalkTimer); avatarWalkTimer = null;
    if (avatarWindow && !avatarWindow.isDestroyed()) avatarWindow.hide();
    currentReminderId = null;
    setTimeout(displayNextReminder, 100);
  });
  ipcMain.handle('overlay:walk-out', () => walkOverlayOffScreen());
  ipcMain.handle('app:test-reminder', () => showReminder({ id: 'test', title: 'Test reminder', message: 'Your desktop avatar is working.' }));
  ipcMain.handle('settings:get', () => {
    const rows = db.prepare("SELECT key, value FROM app_settings WHERE key NOT LIKE 'google_%'").all();
    const result = { speakReminders: true, syncCalendar: true, quietStart: '', quietEnd: '', speechVolume: 0.85, speechRate: 0.96, avatarEnabled: true, allDayReminderTime: '09:00' };
    for (const row of rows) { try { result[row.key] = JSON.parse(row.value); } catch {} }
    return result;
  });
  ipcMain.handle('settings:save', (_event, values) => {
    const allowed = new Set(['speakReminders', 'syncCalendar', 'quietStart', 'quietEnd', 'speechVolume', 'speechRate', 'avatarEnabled', 'calendarIds', 'allDayReminderTime', 'calendarSyncRange']);
    const save = db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at');
    const tx = db.transaction(input => { for (const [key, value] of Object.entries(input || {})) { if (!allowed.has(key)) continue; save.run(key, JSON.stringify(value), new Date().toISOString()); } });
    tx(values);
    if (typeof values?.allDayReminderTime === 'string') calendar.updateAllDayReminderTime(values.allDayReminderTime);
    if (typeof values?.allDayReminderTime === 'string' && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
    return true;
  });
  ipcMain.handle('app:open-external', async (_event, url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Only HTTPS links are allowed.');
    await shell.openExternal(parsed.toString());
  });
}

app.whenReady().then(() => {
  db = openDatabase(path.join(app.getPath('userData'), 'avatar-reminder.sqlite3'));
  seedBasicNeedsReminders(db);
  calendar = createCalendarService({
    app,
    db,
    safeStorage,
    credentialsPath: path.join(app.getPath('userData'), 'google-credentials.json')
  });
  createWindow();
  createAvatarWindow();
  registerIpc();
  scheduleLoop();
  wasOnline = net.isOnline();
  setTimeout(() => syncSelectedCalendars('startup'), 2500);
  calendarSyncTimer = setInterval(() => syncSelectedCalendars('periodic'), 15 * 60 * 1000);
  onlineMonitorTimer = setInterval(() => {
    const online = net.isOnline();
    if (online && !wasOnline) syncSelectedCalendars('online');
    wasOnline = online;
  }, 30000);
  powerMonitor.on('resume', () => { scheduleLoop(); syncSelectedCalendars('resume'); });

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
app.on('before-quit', () => { app.isQuitting = true; clearInterval(reminderTimer); clearInterval(calendarSyncTimer); clearInterval(onlineMonitorTimer); clearInterval(avatarWalkTimer); });
app.on('window-all-closed', (event) => { /* Keep tray app running on Windows. */ });
