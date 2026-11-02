const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, shell, safeStorage, powerMonitor, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { screen } = require('electron');
const { openDatabase } = require('./store.cjs');
const { createCalendarService } = require('./calendar.cjs');
const {
  createLocalTask, updateLocalTask, setLocalTaskEnabled, deleteLocalTask, claimDueTasks, respondToTask, archiveExpiredCompleted,
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
const appIconSvgPath = path.join(__dirname, '..', 'assets', 'icons', 'tray-reminder.svg');
let appIconImage = nativeImage.createEmpty();
if (process.platform === 'win32') app.setAppUserModelId('AvatarReminder.Desktop');
const DEFAULT_SETTINGS = {
  speakReminders: true, syncCalendar: true, quietStart: '', quietEnd: '', speechVolume: 0.85, speechRate: 0.96,
  speechVoice: '', avatarEnabled: true, avatarPosition: 'center', avatarSize: 'medium', animationSpeed: 1,
  walkingAnimationEnabled: true, reactionAnimationsEnabled: true, visualReminders: true, alwaysOnTopOverlay: true,
  enableSound: false, defaultSnoozeMinutes: 30, notificationDisplayDurationSeconds: 0,
  defaultReminderIntervalMinutes: 30, defaultActiveStart: '09:00', defaultActiveEnd: '21:00',
  defaultRecurringBehavior: 'none', missedReminderHandling: 'skip', autoSyncCalendar: true,
  calendarSyncIntervalMinutes: 15, launchOnWindowsStartup: false, minimizeToTray: true,
  startMinimized: false, closeToTray: true, theme: 'dark', defaultCalendarId: 'primary'
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 900,
    minHeight: 620,
    icon: appIconImage,
    show: !setting('startMinimized', false),
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
    if (!app.isQuitting && setting('closeToTray', true)) {
      event.preventDefault();
      mainWindow.hide();
    } else if (!app.isQuitting) {
      app.isQuitting = true;
    }
  });
  mainWindow.on('minimize', event => {
    if (setting('minimizeToTray', true)) { event.preventDefault(); mainWindow.hide(); }
  });
}

function createAvatarWindow() {
  avatarWindow = new BrowserWindow({
    width: 500, height: 370, frame: false, transparent: true,
    alwaysOnTop: setting('alwaysOnTopOverlay', true), show: false, resizable: false, skipTaskbar: true,
    focusable: true, hasShadow: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const url = !app.isPackaged ? 'http://127.0.0.1:5173/#avatar' : `${pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href}#avatar`;
  avatarWindow.loadURL(url);
  avatarWindow.webContents.once('did-finish-load', () => {
    overlayLoaded = true;
    displayNextReminder();
  });
  avatarWindow.setAlwaysOnTop(setting('alwaysOnTopOverlay', true), 'screen-saver');
}

async function loadSvgAppIcon() {
  const svg = fs.readFileSync(appIconSvgPath, 'utf8');
  const svgBase64 = Buffer.from(svg, 'utf8').toString('base64');
  const rasterizer = new BrowserWindow({
    width: 64, height: 64, show: false, frame: false, transparent: true, backgroundColor: '#00000000', offscreen: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  try {
    await rasterizer.loadURL(`data:image/svg+xml;base64,${svgBase64}`);
    await rasterizer.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const icon = await rasterizer.webContents.capturePage({ x: 0, y: 0, width: 64, height: 64 });
    if (icon.isEmpty()) throw new Error('Electron returned an empty icon image.');
    return icon;
  } finally {
    if (!rasterizer.isDestroyed()) rasterizer.destroy();
  }
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
  const position = setting('avatarPosition', 'center');
  const to = position === 'left' ? area.x + 20 : position === 'right' ? area.x + area.width - 500 : area.x + Math.round((area.width - 500) / 2);
  avatarWindow.setPosition(from, y); avatarWindow.showInactive(); avatarWindow.setAlwaysOnTop(setting('alwaysOnTopOverlay', true), 'screen-saver');
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
  if (!setting('visualReminders', true)) {
    if (Notification.isSupported()) new Notification({ title: task.title, body: task.message || 'Your reminder is due.', icon: appIconImage }).show();
    return;
  }
  reminderQueue.push(task);
  if (overlayLoaded && avatarWindow && !avatarWindow.isVisible()) displayNextReminder();
  if (Notification.isSupported()) {
    new Notification({ title: task.title, body: task.message || 'Your reminder is due.', icon: appIconImage }).show();
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
    ensureBasicNeedsOccurrences(db, new Date(), setting('missedReminderHandling', 'skip'));
    if (isQuietHours()) return;
    const now = new Date().toISOString();
    const claimed = claimDueTasks(db, now);
    for (const task of claimed) showReminder(task);
    if (claimed.length && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
  }, 15000);
  const archived = archiveExpiredCompleted(db);
  ensureBasicNeedsOccurrences(db, new Date(), setting('missedReminderHandling', 'skip'));
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
  if (!setting('autoSyncCalendar', true) || !calendar || calendarSyncInProgress || !calendar.status().connected) return;
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

function scheduleCalendarAutoSync() {
  clearInterval(calendarSyncTimer);
  if (!setting('autoSyncCalendar', true)) return;
  const minutes = Math.max(5, Math.min(120, Number(setting('calendarSyncIntervalMinutes', 15)) || 15));
  calendarSyncTimer = setInterval(() => syncSelectedCalendars('periodic'), minutes * 60 * 1000);
}

function registerIpc() {
  ipcMain.handle('tasks:list', () => db.prepare(`SELECT * FROM tasks
    ORDER BY CASE lifecycle_status WHEN 'scheduled' THEN 0 WHEN 'snoozed' THEN 1 WHEN 'notified' THEN 2 WHEN 'due' THEN 2 ELSE 3 END,
    scheduled_reminder_at ASC, created_at DESC`).all());
  ipcMain.handle('tasks:create', (_event, input) => createLocalTask(db, input));
  ipcMain.handle('tasks:update-local', (_event, { id, task }) => updateLocalTask(db, id, task));
  ipcMain.handle('tasks:enabled-local', (_event, { id, enabled }) => setLocalTaskEnabled(db, id, enabled));
  ipcMain.handle('tasks:delete-local', (_event, id) => deleteLocalTask(db, id));
  ipcMain.handle('tasks:history', () => db.prepare(`SELECT reminder_history.*,tasks.title,tasks.source,tasks.lifecycle_status
    FROM reminder_history LEFT JOIN tasks ON tasks.id=reminder_history.task_id
    ORDER BY reminder_history.occurred_at DESC LIMIT 250`).all());
  ipcMain.handle('basic-needs:list', () => listBasicNeedsReminders(db));
  ipcMain.handle('basic-needs:save', (_event, input) => {
    const reminder = saveBasicReminder(db, input);
    ensureBasicNeedsOccurrences(db, new Date(), setting('missedReminderHandling', 'skip'));
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
    return reminder;
  });
  ipcMain.handle('basic-needs:enabled', (_event, { id, enabled }) => {
    const reminder = setBasicReminderEnabled(db, id, enabled);
    ensureBasicNeedsOccurrences(db, new Date(), setting('missedReminderHandling', 'skip'));
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
    return reminder;
  });
  ipcMain.handle('basic-needs:delete', (_event, id) => {
    const deleted = deleteBasicReminder(db, id);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
    return deleted;
  });
  ipcMain.handle('tasks:respond', (_event, { id, response }) => {
    const updated = id === 'test' ? { id, lifecycle_status: response } : respondToTask(db, id, response, new Date(), { snoozeMinutes: setting('defaultSnoozeMinutes', 30) });
    ensureBasicNeedsOccurrences(db, new Date(), setting('missedReminderHandling', 'skip'));
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
    const wasCurrent = currentReminderId === id;
    reminderQueue = reminderQueue.filter(task => task.id !== id);
    if (!wasCurrent && !currentReminderId) setTimeout(displayNextReminder, 100);
    return updated;
  });

  ipcMain.handle('calendar:status', () => calendar.status());
  ipcMain.handle('calendar:disconnect', () => calendar.disconnect());
  ipcMain.handle('calendar:summary', () => ({
    totalImported: db.prepare('SELECT COUNT(*) AS count FROM calendar_events').get().count,
    lastSyncedAt: db.prepare('SELECT MAX(last_synced_at) AS value FROM calendar_sync_state').get().value || null
  }));
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
    if (task.source === 'basic_needs' || (task.recurrence && task.recurrence !== 'none')) {
      throw new Error('Recurring reminders and Basic Needs routines stay in Avatar Reminder and are not added to Google Calendar.');
    }
    const defaultCalendarId = setting('defaultCalendarId', 'primary');
    const result = await calendar.createEvent(task, defaultCalendarId);
    const now = new Date().toISOString();
    db.prepare('UPDATE tasks SET google_event_id = ?, calendar_id = ?, updated_at = ? WHERE id = ?')
      .run(result.id, defaultCalendarId, now, taskId);
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
    const result = { ...DEFAULT_SETTINGS, allDayReminderTime: '09:00' };
    for (const row of rows) { try { result[row.key] = JSON.parse(row.value); } catch {} }
    return result;
  });
  ipcMain.handle('settings:save', (_event, values) => {
    const allowed = new Set([...Object.keys(DEFAULT_SETTINGS), 'calendarIds', 'allDayReminderTime', 'calendarSyncRange']);
    const save = db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at');
    const safeValues = {};
    for (const [key, value] of Object.entries(values || {})) {
      if (!allowed.has(key)) continue;
      if (['speechVolume','speechRate','animationSpeed','defaultSnoozeMinutes','notificationDisplayDurationSeconds','calendarSyncIntervalMinutes','defaultReminderIntervalMinutes'].includes(key) && !Number.isFinite(Number(value))) throw new Error(`Enter a valid number for ${key}.`);
      if (['speechVolume'].includes(key)) safeValues[key] = Math.min(1, Math.max(0, Number(value)));
      else if (key === 'speechRate' || key === 'animationSpeed') safeValues[key] = Math.min(2, Math.max(0.5, Number(value)));
      else if (key === 'defaultSnoozeMinutes') safeValues[key] = Math.min(240, Math.max(1, Math.round(Number(value))));
      else if (key === 'notificationDisplayDurationSeconds') safeValues[key] = Math.min(600, Math.max(0, Math.round(Number(value))));
      else if (key === 'calendarSyncIntervalMinutes') safeValues[key] = Math.min(120, Math.max(5, Math.round(Number(value))));
      else if (key === 'defaultReminderIntervalMinutes') safeValues[key] = Math.min(1440, Math.max(1, Math.round(Number(value))));
      else if (key === 'defaultActiveStart' || key === 'defaultActiveEnd' || key === 'allDayReminderTime') {
        if (!/^\d{2}:\d{2}$/.test(String(value)) || Number(String(value).slice(0,2)) > 23 || Number(String(value).slice(3)) > 59) throw new Error(`Invalid time for ${key}.`);
        safeValues[key] = value;
      }
      else safeValues[key] = value;
    }
    const tx = db.transaction(input => { for (const [key, value] of Object.entries(input)) save.run(key, JSON.stringify(value), new Date().toISOString()); });
    tx(safeValues);
    if (typeof values?.allDayReminderTime === 'string') calendar.updateAllDayReminderTime(values.allDayReminderTime);
    if (typeof values?.allDayReminderTime === 'string' && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:changed');
    if (Object.prototype.hasOwnProperty.call(safeValues, 'alwaysOnTopOverlay') && avatarWindow && !avatarWindow.isDestroyed()) avatarWindow.setAlwaysOnTop(Boolean(safeValues.alwaysOnTopOverlay), 'screen-saver');
    if (['launchOnWindowsStartup','startMinimized'].some(key => Object.prototype.hasOwnProperty.call(safeValues, key)) && process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: Boolean(setting('launchOnWindowsStartup', false)), args: setting('startMinimized', false) ? ['--start-minimized'] : [] });
    }
    if (['autoSyncCalendar', 'calendarSyncIntervalMinutes'].some(key => Object.prototype.hasOwnProperty.call(safeValues, key))) scheduleCalendarAutoSync();
    return true;
  });
  ipcMain.handle('app:open-external', async (_event, url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Only HTTPS links are allowed.');
    await shell.openExternal(parsed.toString());
  });
}

app.whenReady().then(async () => {
  try { appIconImage = await loadSvgAppIcon(); }
  catch (error) { console.error('[app-icon] Could not render SVG icon:', error.message); }
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
  if (setting('autoSyncCalendar', true)) setTimeout(() => syncSelectedCalendars('startup'), 2500);
  scheduleCalendarAutoSync();
  onlineMonitorTimer = setInterval(() => {
    const online = net.isOnline();
    if (online && !wasOnline) syncSelectedCalendars('online');
    wasOnline = online;
  }, 30000);
  powerMonitor.on('resume', () => { scheduleLoop(); syncSelectedCalendars('resume'); });

  let trayImage = appIconImage;
  if (process.platform === 'win32' && !trayImage.isEmpty()) trayImage = trayImage.resize({ width: 16, height: 16 });
  tray = new Tray(trayImage);
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
