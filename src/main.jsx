import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AvatarScene from './scene/AvatarScene.jsx';
import './styles.css';

const isOverlay = window.location.hash === '#avatar';
const DEFAULT_SETTINGS = { speakReminders: true, syncCalendar: true, quietStart: '', quietEnd: '', speechVolume: 0.85, speechRate: 0.96, speechVoice: '', avatarEnabled: true, avatarPosition: 'center', avatarSize: 'medium', animationSpeed: 1, walkingAnimationEnabled: true, reactionAnimationsEnabled: true, visualReminders: true, alwaysOnTopOverlay: true, enableSound: false, defaultSnoozeMinutes: 30, notificationDisplayDurationSeconds: 0, defaultReminderIntervalMinutes: 30, defaultActiveStart: '09:00', defaultActiveEnd: '21:00', defaultRecurringBehavior: 'none', missedReminderHandling: 'skip', autoSyncCalendar: true, calendarSyncIntervalMinutes: 15, launchOnWindowsStartup: false, minimizeToTray: true, startMinimized: false, closeToTray: true, theme: 'dark', allDayReminderTime: '09:00' };
function speak(text, settings, onStart, onEnd) {
  if (!settings?.speakReminders || !('speechSynthesis' in window)) return null;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = Number(settings.speechRate) || 0.96;
  utterance.volume = Number(settings.speechVolume ?? 0.85);
  const voice = window.speechSynthesis.getVoices().find(item => item.voiceURI === settings.speechVoice || item.name === settings.speechVoice);
  if (voice) utterance.voice = voice;
  utterance.onstart = onStart;
  utterance.onend = onEnd;
  utterance.onerror = onEnd;
  window.speechSynthesis.speak(utterance);
  return utterance;
}
function localParts(value) {
  if (!value) return { date: '', time: '' };
  const d = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}
function dateInputValue(date) { const pad = n => String(n).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`; }
function eventTimeLabel(event) {
  if (event.all_day && event.start_at) return `All day · ${new Date(`${event.start_at}T00:00:00`).toLocaleDateString()}`;
  return event.start_at ? new Date(event.start_at).toLocaleString() : 'No start time';
}
function reminderTime(task) {
  const scheduled = task?.scheduled_reminder_at || task?.due_at;
  return scheduled ? new Date(scheduled).toLocaleString() : 'Now';
}
function reminderSpeech(task) {
  return `${task.title}. Scheduled for ${reminderTime(task)}. ${task.message || 'Your reminder is due.'}`;
}
function playReminderChime() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  context.resume().then(() => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(660, now);
    oscillator.frequency.setValueAtTime(880, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(now + 0.34);
    oscillator.onended = () => context.close();
  }).catch(() => context.close());
}
function App() {
  const [tasks, setTasks] = useState([]), [active, setActive] = useState(null);
  const activeRef = useRef(active);
  const [title, setTitle] = useState(''), [date, setDate] = useState(''), [time, setTime] = useState(''), [message, setMessage] = useState(''), [recurrence, setRecurrence] = useState(DEFAULT_SETTINGS.defaultRecurringBehavior), [editingTaskId, setEditingTaskId] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const recurrenceDefaultLoaded = useRef(false);
  useEffect(() => { activeRef.current = active; }, [active]);
  const [settingsLoaded, setSettingsLoaded] = useState(false), [presentationPhase, setPresentationPhase] = useState('hidden'), [isResponding, setIsResponding] = useState(false);
  const [arrivalReady, setArrivalReady] = useState(false), [exitReady, setExitReady] = useState(false);
  const [page, setPage] = useState('dashboard'), [basicNeeds, setBasicNeeds] = useState([]), [basicForm, setBasicForm] = useState(null), [basicSaving, setBasicSaving] = useState(false);
  const presentationRef = useRef({ id: null, arrived: false, walkFinished: false, exitWindowFinished: false, exitWalkFinished: false });
  const spokenReminderIds = useRef(new Set());
  const chimedReminderIds = useRef(new Set());
  const [calendarStatus, setCalendarStatus] = useState({ connected: false, credentialsConfigured: false }), [calendarSummary, setCalendarSummary] = useState({ totalImported: 0, lastSyncedAt: null }), [events, setEvents] = useState([]), [history, setHistory] = useState([]), [error, setError] = useState(''), [notice, setNotice] = useState(''), [listening, setListening] = useState(false), [taskFilter, setTaskFilter] = useState('all'), [speechVoices, setSpeechVoices] = useState([]), [pageLoading, setPageLoading] = useState(false);
  const [calendars, setCalendars] = useState([]), [selectedCalendarIds, setSelectedCalendarIds] = useState([]), [syncRange, setSyncRange] = useState(() => { const start = new Date(); start.setDate(start.getDate() - 30); const end = new Date(); end.setDate(end.getDate() + 365); return { from: dateInputValue(start), to: dateInputValue(end) }; }), [syncing, setSyncing] = useState(false);
  const refresh = async () => { try { const [taskRows, status, savedSettings, summary, historyRows] = await Promise.all([window.avatarApp.listTasks(), window.avatarApp.calendarStatus(), window.avatarApp.getSettings(), window.avatarApp.calendarSummary(), window.avatarApp.taskHistory()]); setTasks(taskRows); setCalendarStatus(status); setSettings({ ...DEFAULT_SETTINGS, ...savedSettings }); if (!recurrenceDefaultLoaded.current) { setRecurrence(savedSettings.defaultRecurringBehavior || 'none'); recurrenceDefaultLoaded.current = true; } setCalendarSummary(summary); setHistory(historyRows); setSettingsLoaded(true); } catch (e) { setError(e.message); } };
  async function loadBasicNeeds() {
    try { setBasicNeeds(await window.avatarApp.listBasicNeeds()); }
    catch (e) { setError(`Could not load Basic Needs reminders: ${e.message}`); }
  }
  async function refreshCalendarData() {
    setPageLoading(true);
    try {
      const [imported, summary, saved] = await Promise.all([window.avatarApp.importedCalendarEvents(), window.avatarApp.calendarSummary(), window.avatarApp.getSettings()]);
      setEvents(imported); setCalendarSummary(summary);
      if (calendarStatus.connected) {
        const available = await window.avatarApp.listCalendars();
        setCalendars(available);
        const selected = (saved.calendarIds || []).filter(id => available.some(item => item.syncId === id));
        setSelectedCalendarIds(selected.length ? selected : available.filter(item => item.primary).map(item => item.syncId));
      } else { setCalendars([]); setSelectedCalendarIds([]); }
    } catch (e) {
      try {
        const status = await window.avatarApp.calendarStatus();
        setCalendarStatus(status);
        if (!status.connected) { setCalendars([]); setSelectedCalendarIds([]); }
      } catch {}
      setError(e.message.includes('authorization expired or was revoked')
        ? 'Google Calendar authorization expired. Reconnect your account to resume synchronization; imported reminders are still saved.'
        : `Could not refresh Google Calendar data: ${e.message}`);
    }
    finally { setPageLoading(false); }
  }
  useEffect(() => { if (page === 'basicNeeds' || page === 'dashboard') loadBasicNeeds(); }, [page, tasks]);
  useEffect(() => {
    refresh();
    const unsubReminder = window.avatarApp.onReminder(task => {
      const id = String(task.id);
      if (String(activeRef.current?.id) === id || presentationRef.current.id === id) return;
      activeRef.current = task;
      presentationRef.current = { id, arrived: false, walkFinished: false, exitWindowFinished: false, exitWalkFinished: false };
      setArrivalReady(false); setExitReady(false); setActive(task); setIsResponding(false); setPresentationPhase('walking_in');
    });
    const unsubArrived = window.avatarApp.onReminderArrived(taskId => {
      if (presentationRef.current.id !== String(taskId)) return;
      presentationRef.current.arrived = true;
      setArrivalReady(true);
      if (presentationRef.current.walkFinished) setPresentationPhase('idle');
    });
    return () => { unsubReminder(); unsubArrived(); window.speechSynthesis?.cancel(); };
  }, []);
  useEffect(() => window.avatarApp.onTasksChanged(refresh), []);
  useEffect(() => {
    if (page === 'history') window.avatarApp.taskHistory().then(setHistory).catch(e => setError(e.message));
  }, [page, tasks]);
  useEffect(() => {
    if (!('speechSynthesis' in window)) return undefined;
    const loadVoices = () => setSpeechVoices(window.speechSynthesis.getVoices());
    loadVoices(); window.speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', loadVoices);
  }, []);
  useEffect(() => {
    if (!isOverlay || presentationPhase !== 'presenting' || !active || !settingsLoaded || !settings.speakReminders || active.speak_enabled === 0) return;
    const id = String(active.id);
    if (spokenReminderIds.current.has(id)) return;
    spokenReminderIds.current.add(id);
    speak(reminderSpeech(active), settings,
      () => setPresentationPhase(current => current === 'presenting' ? 'talking' : current),
      () => setPresentationPhase(current => current === 'talking' ? 'presenting' : current));
  }, [isOverlay, presentationPhase, active, settingsLoaded, settings.speakReminders, settings.speechRate, settings.speechVolume, settings.speechVoice]);
  useEffect(() => {
    if (!isOverlay || presentationPhase !== 'presenting' || !active || (active.sound_enabled !== 1 && !settings.enableSound)) return;
    const id = String(active.id);
    if (chimedReminderIds.current.has(id)) return;
    chimedReminderIds.current.add(id);
    try { playReminderChime(); } catch (e) { console.warn('[reminder-sound] unavailable:', e.message); }
  }, [isOverlay, presentationPhase, active, settings.enableSound]);
  useEffect(() => {
    const seconds = Number(settings.notificationDisplayDurationSeconds) || 0;
    if (!isOverlay || presentationPhase !== 'presenting' || !active || seconds <= 0) return undefined;
    const timer = setTimeout(() => respondTask(active, 'dismiss'), seconds * 1000);
    return () => clearTimeout(timer);
  }, [isOverlay, presentationPhase, active, settings.notificationDisplayDurationSeconds]);
  useEffect(() => { if (isOverlay && !settings.speakReminders) window.speechSynthesis?.cancel(); }, [isOverlay, settings.speakReminders]);
  useEffect(() => { if ((page === 'googleCalendar' || page === 'settings') && !isOverlay) refreshCalendarData(); }, [page, calendarStatus.connected]);
  async function createTask(e) {
    e.preventDefault(); setError(''); setNotice('');
    let dueAt = null;
    if (date || time) {
      if (!date || !time) { setError('Choose both a date and time, or leave both blank.'); return; }
      const candidate = new Date(`${date}T${time}`);
      if (Number.isNaN(candidate.getTime())) { setError('Enter a valid date and time.'); return; }
      if (candidate.getTime() < Date.now() - 60000 && !window.confirm('This time is in the past. Create it as an overdue reminder?')) return;
      dueAt = candidate.toISOString();
    }
    try {
      if (recurrence !== 'none' && !dueAt) { setError('Choose a date and time for a recurring reminder.'); return; }
      const task = editingTaskId
        ? await window.avatarApp.updateLocalTask(editingTaskId, { title, dueAt, message, recurrence })
        : await window.avatarApp.createTask({ title, dueAt, message, recurrence });
      if (!editingTaskId && dueAt && recurrence === 'none' && calendarStatus.connected) {
        const addToCalendar = !settings.syncCalendar || window.confirm('Add this reminder to your Google Calendar?');
        if (addToCalendar) await window.avatarApp.createCalendarEvent(task.id);
      }
      setTitle(''); setDate(''); setTime(''); setMessage(''); setRecurrence(settings.defaultRecurringBehavior || 'none'); setEditingTaskId(null); await refresh(); setNotice(editingTaskId ? 'Reminder updated.' : 'Reminder saved.');
    } catch (e2) { setError(e2.message); }
  }
  async function respondTask(task, response) {
    if (isOverlay && isResponding) return;
    if (isOverlay) setIsResponding(true);
    try {
      await window.avatarApp.respondToTask(task.id, response);
      if (isOverlay) {
        presentationRef.current.exitWindowFinished = false;
        presentationRef.current.exitWalkFinished = false;
        setPresentationPhase(`reacting-${response}`);
      } else if (active?.id === task.id) {
        await window.avatarApp.dismissOverlay();
        setActive(null);
      }
      await refresh();
    } catch (e) { if (isOverlay) setIsResponding(false); setError(e.message); }
  }
  function beginEditTask(task) {
    if (task.source !== 'local') return;
    setEditingTaskId(task.id); setTitle(task.title); setMessage(task.message || ''); setRecurrence(task.recurrence || 'none');
    const value = task.scheduled_reminder_at || task.due_at;
    const parts = localParts(value);
    setDate(parts.date); setTime(parts.time); setPage('myReminders'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function removeTask(task) {
    if (task.source !== 'local' || !window.confirm(`Delete “${task.title}”?`)) return;
    try { await window.avatarApp.deleteLocalTask(task.id); await refresh(); setNotice('Reminder deleted.'); }
    catch (e) { setError(e.message); }
  }
  async function toggleLocalTask(task) {
    try { await window.avatarApp.setLocalTaskEnabled(task.id, task.lifecycle_status === 'paused'); await refresh(); }
    catch (e) { setError(e.message); }
  }
  function onAvatarAnimationComplete(state) {
    const current = presentationRef.current;
    if (state === 'walking_in' && presentationPhase === 'walking_in' && current.id === String(activeRef.current?.id)) {
      current.walkFinished = true;
      if (current.arrived) setPresentationPhase('idle');
    } else if (state === 'idle' && presentationPhase === 'idle') {
      setPresentationPhase('board_entering');
    } else if (state.startsWith('reacting-') && presentationPhase === state) {
      setPresentationPhase('walking_out');
    } else if (state === 'walking_out' && presentationPhase === 'walking_out') {
      current.exitWalkFinished = true;
      finishOverlayExitIfReady();
    }
  }
  function finishOverlayExitIfReady() {
    const current = presentationRef.current;
    if (!current.exitWalkFinished || !current.exitWindowFinished) return;
    window.avatarApp.dismissOverlay().finally(() => {
      presentationRef.current = { id: null, arrived: false, walkFinished: false, exitWindowFinished: false, exitWalkFinished: false };
      activeRef.current = null; setActive(null); setArrivalReady(false); setExitReady(false); setPresentationPhase('hidden'); setIsResponding(false);
    });
  }
  useEffect(() => {
    if (!isOverlay || presentationPhase !== 'walking_out') return;
    let cancelled = false;
    window.avatarApp.walkOutOverlay().then(() => {
      if (cancelled) return;
      presentationRef.current.exitWindowFinished = true;
      setExitReady(true);
      finishOverlayExitIfReady();
    }).catch(error => setError(`The avatar could not walk off-screen: ${error.message}`));
    return () => { cancelled = true; };
  }, [isOverlay, presentationPhase]);
  function onBoardAnimationEnd(event) {
    if (event.target === event.currentTarget && presentationPhase === 'board_entering') setPresentationPhase('presenting');
  }
  async function respond(response) { if (active) await respondTask(active, response); }
  function startVoice() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { setError('Speech recognition is unavailable here. You can type your task instead.'); return; }
    const recognition = new Recognition(); recognition.lang = navigator.language || 'en-US'; recognition.interimResults = false;
    recognition.onstart = () => setListening(true); recognition.onerror = event => { setListening(false); setError(`Microphone recognition failed: ${event.error}. You can type your task instead.`); };
    recognition.onend = () => setListening(false);
    recognition.onresult = event => {
      const transcript = event.results[0][0].transcript.trim();
      const match = transcript.match(/^remind me (.+?) to (.+)$/i);
      if (match) {
        const when = match[1]; const taskTitle = match[2].replace(/[.!?]$/, '');
        const parsed = parseVoiceDate(when);
        setTitle(taskTitle);
        if (parsed) { const parts = localParts(parsed); setDate(parts.date); setTime(parts.time); }
        setNotice(parsed ? `I heard “${taskTitle}” for ${new Date(parsed).toLocaleString()}. Review it before saving.` : `I heard “${taskTitle}”. I couldn't identify “${when}” as a date and time, so review the schedule.`);
      } else setTitle(transcript.replace(/[.!?]$/, ''));
    };
    try { recognition.start(); } catch { setListening(false); }
  }
  async function updateSetting(key, value) { setError(''); try { await window.avatarApp.saveSettings({ [key]: value }); setSettings(current => ({ ...current, [key]: value })); setNotice('Setting saved.'); } catch (e) { setError(e.message); } }
  async function connectCalendar() { setError(''); setPageLoading(true); try { await window.avatarApp.connectCalendar(); await refresh(); await refreshCalendarData(); setNotice('Google Calendar connected.'); } catch (e) { setError(e.message); } finally { setPageLoading(false); } }
  async function disconnectCalendar() { if (!window.confirm('Disconnect Google Calendar? Imported events will remain in Avatar Reminder.')) return; try { await window.avatarApp.disconnectCalendar(); await refresh(); await refreshCalendarData(); setNotice('Google Calendar disconnected. Imported events were kept.'); } catch (e) { setError(e.message); } }
  async function refreshCalendars() { setError(''); try { await refreshCalendarData(); setNotice('Calendar list refreshed.'); } catch (e) { setError(e.message); } }
  function testVoice() { speak('This is a test of your Avatar Reminder voice settings.', { ...settings, speakReminders: true }, null, null); }
  function editBasicReminder(reminder = null) {
    if (!reminder) {
      const defaultInterval = [15,20,30,45,60].includes(Number(settings.defaultReminderIntervalMinutes)) ? String(settings.defaultReminderIntervalMinutes) : 'custom';
      setBasicForm({ id: null, title: '', message: '', repeatMode: defaultInterval, customInterval: Number(settings.defaultReminderIntervalMinutes) || 90, startTime: settings.defaultActiveStart || '09:00', endTime: settings.defaultActiveEnd || '21:00', activeDays: [0,1,2,3,4,5,6], enabled: false, soundEnabled: false, speakEnabled: true });
      return;
    }
    const interval = reminder.interval_minutes == null ? null : Number(reminder.interval_minutes);
    const mode = interval == null ? 'daily' : [15,20,30,45,60].includes(interval) ? String(interval) : 'custom';
    setBasicForm({ id: reminder.id, title: reminder.title, message: reminder.message || '', repeatMode: mode, customInterval: mode === 'custom' ? interval : 90, startTime: reminder.start_time, endTime: reminder.end_time, activeDays: JSON.parse(reminder.active_days || '[0,1,2,3,4,5,6]'), enabled: Boolean(reminder.enabled), soundEnabled: Boolean(reminder.sound_enabled), speakEnabled: Boolean(reminder.speak_enabled) });
  }
  async function saveBasicForm(event) {
    event.preventDefault(); setError(''); setNotice(''); setBasicSaving(true);
    const intervalMinutes = basicForm.repeatMode === 'daily' ? null : basicForm.repeatMode === 'custom' ? Number(basicForm.customInterval) : Number(basicForm.repeatMode);
    try {
      await window.avatarApp.saveBasicReminder({ ...basicForm, intervalMinutes });
      setBasicForm(null); await Promise.all([loadBasicNeeds(), refresh()]); setNotice('Basic reminder saved.');
    } catch (e) { setError(e.message); }
    finally { setBasicSaving(false); }
  }
  async function toggleBasicReminder(reminder) {
    setError('');
    try { await window.avatarApp.setBasicReminderEnabled(reminder.id, !reminder.enabled); await loadBasicNeeds(); await refresh(); }
    catch (e) { setError(e.message); }
  }
  async function removeBasicReminder(reminder) {
    if (!window.confirm(`Delete “${reminder.title}”? Its reminder history will remain in the task list.`)) return;
    setError('');
    try { await window.avatarApp.deleteBasicReminder(reminder.id); setBasicNeeds(await window.avatarApp.listBasicNeeds()); await refresh(); setNotice('Basic reminder deleted.'); }
    catch (e) { setError(e.message); }
  }
  function toggleBasicDay(day) {
    setBasicForm(current => ({ ...current, activeDays: current.activeDays.includes(day) ? current.activeDays.filter(item => item !== day) : [...current.activeDays, day].sort() }));
  }
  async function toggleCalendar(syncId, checked) {
    const next = checked ? [...new Set([...selectedCalendarIds, syncId])] : selectedCalendarIds.filter(id => id !== syncId);
    setSelectedCalendarIds(next); try { await window.avatarApp.saveSettings({ calendarIds: next }); } catch (e) { setError(e.message); }
  }
  async function loadEvents() {
    setError(''); setNotice('');
    if (!selectedCalendarIds.length) { setError('Select at least one calendar to sync.'); return; }
    if (syncRange.from && syncRange.to && syncRange.from > syncRange.to) { setError('The end date must be on or after the start date.'); return; }
    const localMidnight = value => { if (!value) return undefined; const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d).toISOString(); };
    let timeMax;
    if (syncRange.to) { const [y, m, d] = syncRange.to.split('-').map(Number); const next = new Date(y, m - 1, d + 1); timeMax = next.toISOString(); }
    setSyncing(true);
    try {
      const result = await window.avatarApp.syncCalendars({ calendarIds: selectedCalendarIds, timeMin: localMidnight(syncRange.from), timeMax });
      setEvents(await window.avatarApp.importedCalendarEvents());
      setCalendarSummary(await window.avatarApp.calendarSummary());
      const summary = `${result.calendarsChecked} calendar(s) checked · ${result.eventsRetrieved} retrieved · ${result.eventsAdded} added · ${result.eventsUpdated} updated`;
      if (result.success) setNotice(`Sync complete: ${summary}.`);
      else setError(`Sync incomplete: ${summary}. ${result.errors.map(item => `${item.calendarId}: ${item.message}`).join(' ')}`);
    } catch (e) { setError(`Sync failed: ${e.message}`); }
    finally { setSyncing(false); }
  }
  async function syncTask(task) { setError(''); try { await window.avatarApp.createCalendarEvent(task.id); await refresh(); setNotice('Event created in Google Calendar.'); } catch (e) { setError(e.message); } }
  const currentYear = new Date().getFullYear();
  const visibleTasks = tasks.filter(task => {
    if (task.source === 'local' && task.lifecycle_status === 'cancelled') return false;
    if (taskFilter === 'all') return true;
    if (taskFilter === 'upcoming') {
      if (!['scheduled', 'snoozed'].includes(task.lifecycle_status)) return false;
      if (task.source !== 'google_calendar') return true;
      const eventDate = task.event_start_at || task.scheduled_reminder_at || task.due_at;
      return Boolean(eventDate) && new Date(eventDate).getFullYear() === currentYear;
    }
    if (taskFilter === 'due') return ['due', 'notified'].includes(task.lifecycle_status);
    if (taskFilter === 'completed') return ['completed', 'archived'].includes(task.lifecycle_status);
    if (taskFilter === 'google') return task.source === 'google_calendar';
    if (taskFilter === 'local') return task.source === 'local' || task.source === 'basic_needs';
    return false;
  });
  const visibleCalendarEvents = events.filter(event => event.start_at && new Date(event.start_at).getFullYear() === currentYear);
  const intervalLabel = reminder => reminder.interval_minutes == null ? 'Once per active day' : `Every ${reminder.interval_minutes} minutes`;
  const todayKey = dateInputValue(new Date());
  const dashboardTasks = tasks.filter(task => {
    const eventDate = task.event_start_at || task.scheduled_reminder_at || task.due_at;
    if (!eventDate) return task.source !== 'google_calendar';
    return new Date(eventDate).getFullYear() === currentYear;
  });
  const dashboardCalendarTaskCount = dashboardTasks.filter(task => task.source === 'google_calendar').length;
  const activeTasks = dashboardTasks.filter(task => !['completed','archived','cancelled','dismissed','paused'].includes(task.lifecycle_status));
  const upcoming = activeTasks.filter(task => { const when = task.scheduled_reminder_at || task.due_at; return when && new Date(when) >= new Date(); }).sort((a,b) => new Date(a.scheduled_reminder_at || a.due_at)-new Date(b.scheduled_reminder_at || b.due_at));
  const completedToday = history.filter(item => item.event_type === 'response' && item.response === 'done' && item.occurred_at && dateInputValue(new Date(item.occurred_at)) === todayKey);
  const recurringCount = basicNeeds.filter(item => item.enabled).length + tasks.filter(item => item.source === 'local' && item.recurrence && item.recurrence !== 'none' && item.lifecycle_status !== 'completed').length;
  if (!isOverlay) return <ControlCenter app={{ tasks, title, setTitle, date, setDate, time, setTime, message, setMessage, recurrence, setRecurrence, editingTaskId, setEditingTaskId, settings, updateSetting, page, setPage, basicNeeds, basicForm, setBasicForm, basicSaving, calendarStatus, calendarSummary, events, history, setHistory, error, setError, notice, setNotice, listening, taskFilter, setTaskFilter, speechVoices, pageLoading, calendars, selectedCalendarIds, syncRange, setSyncRange, syncing, refresh, createTask, respondTask, beginEditTask, removeTask, toggleLocalTask, syncTask, startVoice, connectCalendar, disconnectCalendar, refreshCalendars, testVoice, editBasicReminder, saveBasicForm, toggleBasicReminder, removeBasicReminder, toggleBasicDay, toggleCalendar, loadEvents, visibleTasks, visibleCalendarEvents, currentYear, upcoming, activeTasks, dashboardCalendarTaskCount, completedToday, recurringCount, intervalLabel, settingsLoaded, todayKey }} />;
  if (isOverlay) return <main className="overlay-shell"><div className={`overlay-character${settings.avatarEnabled ? '' : ' avatar-disabled'}`}><AvatarScene state={presentationPhase} arrivalReady={arrivalReady} exitReady={exitReady} avatarSize={settings.avatarSize} animationSpeed={settings.animationSpeed} walkingEnabled={settings.walkingAnimationEnabled} reactionsEnabled={settings.reactionAnimationsEnabled} onAnimationComplete={onAvatarAnimationComplete} onError={message => console.error('[avatar-renderer]', message)} /></div>{active && ['board_entering', 'presenting', 'talking'].includes(presentationPhase) && <section className={`overlay-card${presentationPhase === 'board_entering' ? ' board-entering' : ''}`} onAnimationEnd={onBoardAnimationEnd} aria-live="polite"><div className="overlay-kicker">AVATAR REMINDER</div><h2>{active.title}</h2><small className="overlay-time">Scheduled · {reminderTime(active)}</small><p>{active.message || 'Your reminder is due.'}</p><div className="response-row"><button className="primary" disabled={isResponding} onClick={() => respond('done')}>Done</button><button disabled={isResponding} onClick={() => respond('snooze')}>Snooze / Later</button><button className="quiet" disabled={isResponding} onClick={() => respond('dismiss')}>Dismiss</button></div></section>}</main>;
  if (page === 'basicNeeds') return <main className="app-shell">
    <header className="topbar"><div><div className="eyebrow">PERSONAL ROUTINE</div><h1>Basic Needs</h1></div><nav className="page-nav"><button onClick={() => { setBasicForm(null); setPage('reminders'); }}>Reminders</button><button className="selected" onClick={() => setPage('basicNeeds')}>Basic Needs</button></nav></header>
    {error && <div className="notice error">{error}</div>}{notice && <div className="notice">{notice}</div>}
    {basicForm ? <section className="panel basic-editor"><h2>{basicForm.id ? 'Edit basic reminder' : 'Add basic reminder'}</h2><form onSubmit={saveBasicForm} className="task-form">
      <label>Reminder title<input required maxLength={120} value={basicForm.title} onChange={e => setBasicForm({ ...basicForm, title: e.target.value })} placeholder="e.g. Take a walk" /></label>
      <label>Description / message<input maxLength={500} value={basicForm.message} onChange={e => setBasicForm({ ...basicForm, message: e.target.value })} placeholder="A short message shown on the reminder board" /></label>
      <label>Repeat interval<select value={basicForm.repeatMode} onChange={e => setBasicForm({ ...basicForm, repeatMode: e.target.value })}><option value="daily">Once per active day</option>{[15,20,30,45,60].map(minutes => <option key={minutes} value={minutes}>Every {minutes} minutes</option>)}<option value="custom">Custom interval</option></select></label>
      {basicForm.repeatMode === 'custom' && <label>Custom interval in minutes<input type="number" min="1" max="1440" required value={basicForm.customInterval} onChange={e => setBasicForm({ ...basicForm, customInterval: e.target.value })} /></label>}
      <div className="date-time-row"><label>Start time<input type="time" required value={basicForm.startTime} onChange={e => setBasicForm({ ...basicForm, startTime: e.target.value })} /></label><label>End time<input type="time" required value={basicForm.endTime} onChange={e => setBasicForm({ ...basicForm, endTime: e.target.value })} /></label></div>
      <fieldset className="days-field"><legend>Active days</legend><div className="days-checks">{[['Mon',1],['Tue',2],['Wed',3],['Thu',4],['Fri',5],['Sat',6],['Sun',0]].map(([label, day]) => <label className="check-setting" key={day}><input type="checkbox" checked={basicForm.activeDays.includes(day)} onChange={() => toggleBasicDay(day)} />{label}</label>)}</div></fieldset>
      <label className="check-setting"><input type="checkbox" checked={basicForm.enabled} onChange={e => setBasicForm({ ...basicForm, enabled: e.target.checked })} />Enabled</label>
      <label className="check-setting"><input type="checkbox" checked={basicForm.soundEnabled} onChange={e => setBasicForm({ ...basicForm, soundEnabled: e.target.checked })} />Play a sound when it appears</label>
      <label className="check-setting"><input type="checkbox" checked={basicForm.speakEnabled} onChange={e => setBasicForm({ ...basicForm, speakEnabled: e.target.checked })} />Speak this reminder when speech is enabled globally</label>
      <div className="response-row"><button className="primary" type="submit" disabled={basicSaving}>{basicSaving ? 'Saving…' : 'Save reminder'}</button><button type="button" onClick={() => setBasicForm(null)}>Cancel</button></div>
    </form></section> : <>
      <div className="section-heading basic-heading"><p className="muted">Choose a template, adjust its schedule, and enable only the reminders you want.</p><button className="primary" onClick={() => editBasicReminder()}>Add Basic Reminder</button></div>
      <div className="basic-reminder-list">{basicNeeds.map(reminder => <article className="panel basic-reminder-row" key={reminder.id}><div className="basic-reminder-copy"><div className="section-heading"><h2>{reminder.title}</h2><span className={`status ${reminder.enabled ? 'good' : ''}`}>{reminder.enabled ? 'Enabled' : 'Disabled'}</span></div><small>{intervalLabel(reminder)} · {reminder.start_time}–{reminder.end_time} · {JSON.parse(reminder.active_days || '[]').length} active day(s)</small><small>Next reminder: {reminder.enabled && reminder.next_reminder_at ? new Date(reminder.next_reminder_at).toLocaleString() : 'Not scheduled'}</small></div><div className="task-actions"><button onClick={() => editBasicReminder(reminder)}>Edit</button><button onClick={() => toggleBasicReminder(reminder)}>{reminder.enabled ? 'Pause' : 'Resume'}</button><button className="quiet" onClick={() => removeBasicReminder(reminder)}>Delete</button></div></article>)}</div>
    </>}
    <footer>Repeating reminder definitions stay saved when an individual occurrence is completed or skipped.</footer>
  </main>;
  return <main className="app-shell">
    <header className="topbar"><div><div className="eyebrow">YOUR DESKTOP COMPANION</div><h1>Avatar Reminder</h1></div><div className="main-header-actions"><nav className="page-nav"><button className="selected" onClick={() => setPage('reminders')}>Reminders</button><button onClick={() => { setError(''); setNotice(''); setPage('basicNeeds'); }}>Basic Needs</button></nav><div className="response-row"><button onClick={() => window.avatarApp.testReminder()}>Test reminder</button><button className="icon-button" onClick={() => window.avatarApp.hideWindow()} aria-label="Hide window">—</button></div></div></header>
    <section className="panel"><h2>Create a reminder</h2><form onSubmit={createTask} className="task-form"><label>Task title<div className="input-action"><input value={title} onChange={e => setTitle(e.target.value)} placeholder="Drink water" required /><button type="button" onClick={startVoice} aria-label="Speak a task">{listening ? 'Listening…' : '🎙 Mic'}</button></div></label><div className="date-time-row"><label>Reminder date<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label><label>Reminder time<input type="time" value={time} onChange={e => setTime(e.target.value)} /></label></div><label>Message shown on screen<input value={message} onChange={e => setMessage(e.target.value)} placeholder="Hey! Take a short break." /></label><button className="primary" type="submit">Add reminder</button></form></section>
    <section className="panel"><div className="section-heading"><h2>Your tasks</h2><button onClick={refresh}>Refresh</button></div><div className="task-filters">{['upcoming','due','completed','all'].map(filter => <button key={filter} className={taskFilter === filter ? 'selected' : ''} onClick={() => setTaskFilter(filter)}>{filter === 'upcoming' ? `Upcoming (${currentYear})` : filter[0].toUpperCase()+filter.slice(1)}</button>)}</div><div className="task-list">{visibleTasks.length === 0 && <p className="muted">No {taskFilter} tasks.</p>}{visibleTasks.map(task => { const remindAt = task.scheduled_reminder_at || task.due_at; const calendarName = calendars.find(item => item.syncId === task.calendar_id)?.name || task.calendar_id; const sourceName = task.source === 'google_calendar' ? 'Google Calendar' : task.source === 'basic_needs' ? 'Basic Needs' : 'Local Task'; return <article className="task-row" key={task.id}><div className="task-copy"><strong>{task.title}</strong><small>{sourceName}{task.calendar_id ? ` · ${calendarName}` : ''} · {remindAt ? new Date(remindAt).toLocaleString() : 'No time set'} · {task.lifecycle_status || task.status}{task.all_day ? ` · All day (reminder ${settings.allDayReminderTime || '09:00'})` : ''}</small></div><div className="task-actions">{!['completed','archived','cancelled','dismissed'].includes(task.lifecycle_status) && <button onClick={() => respondTask(task,'done')}>Done</button>}{['notified','due'].includes(task.lifecycle_status) && <><button onClick={() => respondTask(task,'snooze')}>Snooze</button><button onClick={() => respondTask(task,'dismiss')}>Dismiss</button></>}{task.source !== 'google_calendar' && task.source !== 'basic_needs' && remindAt && !task.google_event_id && <button onClick={() => syncTask(task)}>Add to Calendar</button>}{task.google_event_id && <span className="synced">Calendar linked</span>}</div></article>; })}</div></section>
    <section className="panel calendar-panel">
      <div className="section-heading"><h2>Google Calendar</h2><span className={calendarStatus.connected ? 'status good' : 'status'}>{calendarStatus.connected ? 'Connected' : 'Not connected'}</span></div>
      <label className="check-setting"><input type="checkbox" checked={settings.syncCalendar} onChange={e => updateSetting('syncCalendar', e.target.checked)} /> Ask before adding reminders to Google Calendar</label>
      <label>All-day event reminder time<input type="time" value={settings.allDayReminderTime || '09:00'} onChange={e => updateSetting('allDayReminderTime', e.target.value)} /><small>All-day events use this local time for their reminder.</small></label>
      <div className="response-row"><button className="primary" onClick={connectCalendar} disabled={!calendarStatus.credentialsConfigured}>Connect Google</button></div>
      {!calendarStatus.credentialsConfigured && <p className="muted">Configure Google OAuth by placing google-credentials.json in the app data folder. See README.</p>}
      {calendarStatus.connected && <>
        <h3>Calendars to sync</h3>
        <div className="calendar-options">{calendars.map(item => <label className="check-setting calendar-option" key={item.syncId}><input type="checkbox" checked={selectedCalendarIds.includes(item.syncId)} onChange={e => toggleCalendar(item.syncId, e.target.checked)} /><span><strong>{item.name}</strong><small>ID: {item.id} · {item.primary ? 'Primary' : 'Other'} · Access: {item.accessRole}</small></span></label>)}</div>
        <div className="date-time-row"><label>From date<input type="date" value={syncRange.from} onChange={e => setSyncRange({ ...syncRange, from: e.target.value })} /></label><label>Through date<input type="date" value={syncRange.to} onChange={e => setSyncRange({ ...syncRange, to: e.target.value })} /></label></div>
        <div className="response-row"><button className="primary" onClick={loadEvents} disabled={syncing || !selectedCalendarIds.length}>{syncing ? 'Syncing…' : 'Sync selected calendars'}</button></div>
        <h3>Imported events ({currentYear}: {visibleCalendarEvents.length})</h3>
        {visibleCalendarEvents.map(event => <article className="event-row calendar-event" key={`${event.calendar_id}:${event.google_event_id}`}><div><strong>{event.title}</strong><small>{eventTimeLabel(event)}{!event.all_day && event.end_at ? ` – ${new Date(event.end_at).toLocaleString()}` : ''} · {event.event_status}{event.location ? ` · ${event.location}` : ''}</small></div></article>)}
      </>}
    </section>
    {(error || notice) && <div className={error ? 'notice error' : 'notice'}>{error || notice}</div>}<footer>Reminder messages always appear on screen. Speech is optional.</footer>
  </main>;
}
function ReminderCalendar({ app, renderTask }) {
  const [month, setMonth] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const [selectedDay, setSelectedDay] = useState(() => dateInputValue(new Date()));
  const year = month.getFullYear(), monthIndex = month.getMonth();
  const firstDay = new Date(year, monthIndex, 1);
  const cellCount = Math.ceil((firstDay.getDay() + new Date(year, monthIndex + 1, 0).getDate()) / 7) * 7;
  const keyOf = date => dateInputValue(date);
  const keyOfTimestamp = timestamp => /^\d{4}-\d{2}-\d{2}$/.test(String(timestamp || '')) ? String(timestamp) : timestamp ? keyOf(new Date(timestamp)) : '';
  const timestampFor = task => task.lifecycle_status === 'completed' ? task.completed_at : task.event_start_at || task.scheduled_reminder_at || task.due_at;
  const monthTasks = app.visibleTasks.filter(task => {
    const timestamp = timestampFor(task);
    return timestamp && keyOfTimestamp(timestamp).slice(0, 7) === `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
  });
  const cells = Array.from({ length: cellCount }, (_, index) => new Date(year, monthIndex, index - firstDay.getDay() + 1));
  const tasksOn = key => monthTasks.filter(task => timestampFor(task) && keyOfTimestamp(timestampFor(task)) === key);
  const selectedTasks = tasksOn(selectedDay);
  const moveMonth = amount => { const next = new Date(year, monthIndex + amount, 1); setMonth(next); setSelectedDay(keyOf(next)); };
  const selectToday = () => { const today = new Date(); setMonth(new Date(today.getFullYear(), today.getMonth(), 1)); setSelectedDay(keyOf(today)); };
  return <section className="panel reminder-calendar-panel">
    <div className="calendar-toolbar"><div><span className="eyebrow">CALENDAR VIEW</span><h2>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2></div><div className="calendar-month-controls"><button aria-label="Previous month" onClick={() => moveMonth(-1)}>‹</button><button onClick={selectToday}>Today</button><button aria-label="Next month" onClick={() => moveMonth(1)}>›</button></div></div>
    <div className="reminder-calendar"><div className="calendar-weekdays">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day => <div key={day}>{day}</div>)}</div><div className="calendar-days">{cells.map((day,index) => { const key = keyOf(day), items = tasksOn(key), inMonth = day.getMonth() === monthIndex; return <button type="button" key={`${key}-${index}`} className={`calendar-day${inMonth?'':' outside-month'}${selectedDay===key?' selected-day':''}${key===keyOf(new Date())?' today':''}`} onClick={() => setSelectedDay(key)}><span className="day-number">{day.getDate()}</span>{items.slice(0,3).map(task => <span title={task.title} className={`calendar-chip ${task.source==='google_calendar'?'calendar-chip-google':task.source==='basic_needs'?'calendar-chip-basic':''}`} key={task.id}>{task.title}</span>)}{items.length>3&&<span className="calendar-more">+{items.length-3} more</span>}{items.length>0&&<span className="calendar-dots">{items.length>3?'•••':''}</span>}</button>; })}</div></div>
    <div className="calendar-agenda"><div className="panel-heading"><div><span className="eyebrow">DAY AGENDA</span><h2>{new Date(`${selectedDay}T12:00:00`).toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})}</h2></div><span className="count-pill">{selectedTasks.length} reminder{selectedTasks.length===1?'':'s'}</span></div>{selectedTasks.length ? <div className="task-list">{selectedTasks.map(renderTask)}</div> : <p className="empty-state">Nothing scheduled for this day.</p>}</div>
    <div className="calendar-legend"><span><i className="legend-dot local-dot"/> Local task</span><span><i className="legend-dot google-dot"/> Google Calendar</span><span><i className="legend-dot basic-dot"/> Basic Needs</span></div>
  </section>;
}
function ControlCenter({ app: a }) {
  const nav = [['dashboard','Dashboard'],['myReminders','My Reminders'],['basicNeeds','Basic Needs'],['googleCalendar','Google Calendar'],['history','Reminder History'],['settings','Settings']];
  const label = nav.find(row => row[0] === a.page)?.[1] || 'Dashboard';
  const taskRow = task => {
    const when = task.scheduled_reminder_at || task.due_at;
    const source = task.source === 'google_calendar' ? 'Google Calendar' : task.source === 'basic_needs' ? 'Basic Needs' : 'Local Task';
    const closed = ['completed','archived','cancelled','dismissed'].includes(task.lifecycle_status);
    const paused = task.lifecycle_status === 'paused';
    return <article className="task-row" key={task.id}><div className="task-copy"><strong>{task.title}</strong><small><span className="source-tag">{source}</span> · {when ? new Date(when).toLocaleString() : 'No time set'} · {task.lifecycle_status || task.status}</small></div><div className="task-actions">{task.source === 'local' && !closed && <><button onClick={() => a.beginEditTask(task)}>Edit</button><button onClick={() => a.toggleLocalTask(task)}>{paused ? 'Resume' : 'Pause'}</button><button onClick={() => a.removeTask(task)}>Delete</button></>}{!closed && !paused && <button onClick={() => a.respondTask(task,'done')}>Done</button>}{['due','notified'].includes(task.lifecycle_status) && <><button onClick={() => a.respondTask(task,'snooze')}>Snooze</button><button onClick={() => a.respondTask(task,'dismiss')}>Dismiss</button></>}{task.source === 'local' && (!task.recurrence || task.recurrence === 'none') && when && !task.google_event_id && a.calendarStatus.connected && <button onClick={() => a.syncTask(task)}>Add to Calendar</button>}{task.google_event_id && <span className="synced">Calendar linked</span>}</div></article>;
  };
  const toggle = (key, title, sub) => <label className="setting-line" key={key}><span><strong>{title}</strong><small>{sub}</small></span><input type="checkbox" checked={!!a.settings[key]} onChange={e => a.updateSetting(key,e.target.checked)} /></label>;
  const control = (title, key, type='text', props={}) => <label>{title}<input type={type} value={a.settings[key] ?? ''} {...props} onChange={e => a.updateSetting(key,type === 'number' ? Number(e.target.value) : e.target.value)} /></label>;
  if (!a.settingsLoaded) return <main className="loading-shell"><div className="loading-mark">AR</div><strong>Loading Avatar Reminder…</strong><span>Connecting to your local reminders</span></main>;
  return <main className={`control-center theme-${a.settings.theme || 'dark'}`}>
    <aside className="sidebar"><div className="brand"><div className="brand-icon">A</div><div><strong>Avatar Reminder</strong><small>DESKTOP COMPANION</small></div></div><nav className="side-nav">{nav.map(([id,name]) => <button className={a.page === id ? 'active' : ''} key={id} onClick={() => { a.setError(''); a.setNotice(''); a.setPage(id); }}><span className="nav-bullet">{['◈','◷','♡','▦','≡','⚙'][nav.findIndex(row=>row[0]===id)]}</span>{name}{id === 'myReminders' && a.upcoming.length > 0 && <em>{a.upcoming.length}</em>}</button>)}</nav><div className="sidebar-bottom"><span className={`connection-dot ${a.calendarStatus.connected ? 'online' : ''}`} />{a.calendarStatus.connected ? 'Google Calendar connected' : 'Calendar not connected'}<button className="test-reminder" onClick={() => window.avatarApp.testReminder()}>＋ Test reminder</button><small>Avatar Reminder · Desktop</small></div></aside>
    <section className="workspace"><header className="workspace-header"><div><div className="eyebrow">{label.toUpperCase()}</div><h1>{a.page === 'dashboard' ? 'Good day' : label}</h1></div><div className="header-right"><span>{new Date().toLocaleDateString(undefined,{weekday:'short',month:'long',day:'numeric'})}</span><button onClick={a.refresh}>↻ Refresh</button><button className="icon-button" onClick={() => window.avatarApp.hideWindow()} aria-label="Hide window">—</button></div></header>
    {(a.error || a.notice) && <div className={`notice ${a.error ? 'error' : ''}`}>{a.error || a.notice}<button className="notice-close" onClick={() => {a.setError('');a.setNotice('');}}>×</button></div>}
    <div className="page-content">
    {a.page === 'dashboard' && <><div className="welcome-row"><div><h2>Your day, at a glance</h2><p>Current-year events and reminder activity at a glance.</p></div><button className="primary" onClick={() => a.setPage('myReminders')}>＋ New reminder</button></div><div className="stat-grid">{[['Total active reminders',a.activeTasks.length + a.basicNeeds.filter(x=>x.enabled).length,'Scheduled and enabled'],['Upcoming reminders',a.upcoming.length,'Coming up this year'],['Completed today',a.completedToday.length,'From your reminder history'],['Recurring reminders',a.recurringCount,'Active schedules']].map(([name,count,sub])=><article className="stat-card" key={name}><span>{name}</span><strong>{count}</strong><small>{sub}</small></article>)}<article className="stat-card calendar-stat"><span>Google Calendar · {a.currentYear}</span><strong className="stat-text">{a.calendarStatus.connected ? 'Connected' : 'Not connected'}</strong><small>{a.dashboardCalendarTaskCount} imported events this year · {a.calendarSummary.lastSyncedAt ? new Date(a.calendarSummary.lastSyncedAt).toLocaleString() : 'Not synced yet'}</small></article></div><div className="dashboard-grid"><section className="panel"><div className="eyebrow">UP NEXT</div><h2>Next reminder</h2>{a.upcoming[0] ? <><strong className="next-title">{a.upcoming[0].title}</strong><p className="muted">{new Date(a.upcoming[0].scheduled_reminder_at || a.upcoming[0].due_at).toLocaleString()}</p><button onClick={() => a.setPage('myReminders')}>View reminders →</button></> : <p className="empty-state">Nothing scheduled. Add a reminder to get started.</p>}</section><section className="panel"><div className="eyebrow">TODAY</div><h2>Reminder timeline</h2>{a.upcoming.filter(t => {const d=t.scheduled_reminder_at||t.due_at;return d && new Date(d).toDateString()===new Date().toDateString()}).slice(0,8).map(taskRow)}{!a.upcoming.some(t => {const d=t.scheduled_reminder_at||t.due_at;return d && new Date(d).toDateString()===new Date().toDateString()}) && <p className="empty-state">No upcoming reminders today.</p>}</section><section className="panel"><div className="panel-heading"><div className="eyebrow">ROUTINES</div><button onClick={()=>a.setPage('basicNeeds')}>Manage →</button></div><h2>Active recurring reminders</h2>{a.basicNeeds.filter(x=>x.enabled).map(x=><div className="compact-row" key={x.id}><strong>{x.title}</strong><small>{a.intervalLabel(x)} · next {x.next_reminder_at ? new Date(x.next_reminder_at).toLocaleString() : 'not scheduled'}</small></div>)}{!a.basicNeeds.some(x=>x.enabled)&&<p className="empty-state">No active routines.</p>}</section><section className="panel"><div className="panel-heading"><div className="eyebrow">RECENT ACTIVITY</div><button onClick={()=>a.setPage('history')}>View history →</button></div><h2>Recently completed</h2>{a.completedToday.slice(0,5).map(taskRow)}{!a.completedToday.length&&<p className="empty-state">Completed tasks appear here.</p>}</section></div></>}
    {a.page === 'myReminders' && <><div className="welcome-row"><div><h2>Manage your reminders</h2><p>Local reminders, recurring tasks and imported calendar events.</p></div></div><section className="panel"><h2>{a.editingTaskId ? 'Edit reminder' : 'Add a reminder'}</h2><form className="task-form" onSubmit={a.createTask}><label>Title<div className="input-action"><input required value={a.title} onChange={e=>a.setTitle(e.target.value)} /><button type="button" onClick={a.startVoice}>{a.listening?'Listening…':'🎙 Mic'}</button></div></label><div className="date-time-row"><label>Date<input type="date" value={a.date} onChange={e=>a.setDate(e.target.value)} /></label><label>Time<input type="time" value={a.time} onChange={e=>a.setTime(e.target.value)} /></label></div><label>Message<input value={a.message} onChange={e=>a.setMessage(e.target.value)} /></label><label>Recurrence<select value={a.recurrence} onChange={e=>a.setRecurrence(e.target.value)}><option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><div className="response-row"><button className="primary">{a.editingTaskId?'Save changes':'Add reminder'}</button></div></form></section><section className="panel"><div className="panel-heading"><h2>Reminders calendar</h2><button onClick={a.refresh}>Refresh</button></div><div className="task-filters">{[['all','All'],['upcoming','Upcoming'],['due','Due'],['completed','Completed'],['google','Google Calendar'],['local','Local Tasks']].map(([id,name])=><button key={id} className={a.taskFilter===id?'selected':''} onClick={()=>a.setTaskFilter(id)}>{name}</button>)}</div><ReminderCalendar app={a} renderTask={taskRow}/></section></>}
    {a.page === 'basicNeeds' && <><div className="welcome-row"><div><h2>Healthy habits, made simple</h2><p>Configure intervals, active hours and days for each routine.</p></div><button className="primary" onClick={()=>a.editBasicReminder()}>＋ Add Basic Reminder</button></div>{a.basicForm ? <section className="panel basic-editor"><h2>{a.basicForm.id?'Edit reminder':'New basic reminder'}</h2><form className="task-form" onSubmit={a.saveBasicForm}><label>Title<input required value={a.basicForm.title} onChange={e=>a.setBasicForm({...a.basicForm,title:e.target.value})}/></label><label>Description<input value={a.basicForm.message} onChange={e=>a.setBasicForm({...a.basicForm,message:e.target.value})}/></label><label>Interval<select value={a.basicForm.repeatMode} onChange={e=>a.setBasicForm({...a.basicForm,repeatMode:e.target.value})}><option value="daily">Once per active day</option>{[15,20,30,45,60].map(n=><option value={n} key={n}>Every {n} minutes</option>)}<option value="custom">Custom</option></select></label>{a.basicForm.repeatMode==='custom'&&<label>Custom minutes<input type="number" min="1" max="1440" value={a.basicForm.customInterval} onChange={e=>a.setBasicForm({...a.basicForm,customInterval:e.target.value})}/></label>}<div className="date-time-row"><label>Start<input type="time" value={a.basicForm.startTime} onChange={e=>a.setBasicForm({...a.basicForm,startTime:e.target.value})}/></label><label>End<input type="time" value={a.basicForm.endTime} onChange={e=>a.setBasicForm({...a.basicForm,endTime:e.target.value})}/></label></div><fieldset className="days-field"><legend>Active days</legend><div className="days-checks">{[['Mon',1],['Tue',2],['Wed',3],['Thu',4],['Fri',5],['Sat',6],['Sun',0]].map(([name,day])=><label className="check-setting" key={day}><input type="checkbox" checked={a.basicForm.activeDays.includes(day)} onChange={()=>a.toggleBasicDay(day)}/>{name}</label>)}</div></fieldset>{[['enabled','Enabled'],['soundEnabled','Play sound'],['speakEnabled','Speak reminder']].map(([k,name])=><label className="check-setting" key={k}><input type="checkbox" checked={a.basicForm[k]} onChange={e=>a.setBasicForm({...a.basicForm,[k]:e.target.checked})}/>{name}</label>)}<div className="response-row"><button className="primary" disabled={a.basicSaving}>{a.basicSaving?'Saving…':'Save reminder'}</button><button type="button" onClick={()=>a.setBasicForm(null)}>Cancel</button></div></form></section> : <div className="basic-reminder-list">{a.basicNeeds.map(item=><article className="panel basic-reminder-row" key={item.id}><div><div className="section-heading"><h2>{item.title}</h2><span className={`status ${item.enabled?'good':''}`}>{item.enabled?'Enabled':'Paused'}</span></div><small>{a.intervalLabel(item)} · {item.start_time}–{item.end_time} · next {item.enabled&&item.next_reminder_at?new Date(item.next_reminder_at).toLocaleString():'not scheduled'}</small></div><div className="task-actions"><button onClick={()=>a.editBasicReminder(item)}>Edit</button><button onClick={()=>a.toggleBasicReminder(item)}>{item.enabled?'Pause':'Resume'}</button><button onClick={()=>a.removeBasicReminder(item)}>Delete</button></div></article>)}</div>}</>}
    {a.page === 'googleCalendar' && <><div className="welcome-row"><div><h2>Calendar connection and sync</h2><p>Imported Google events are stored locally and kept when disconnected.</p></div><span className={`connection-badge ${a.calendarStatus.connected?'connected':''}`}>{a.calendarStatus.connected?'Connected':'Disconnected'}</span></div><div className="stat-grid"><article className="stat-card"><span>Account</span><strong className="stat-text">{a.calendars.find(c=>c.primary)?.name || (a.calendarStatus.connected?'Connected':'Not connected')}</strong></article><article className="stat-card"><span>Imported events</span><strong>{a.calendarSummary.totalImported||0}</strong></article><article className="stat-card"><span>Last sync</span><strong className="stat-text">{a.calendarSummary.lastSyncedAt?new Date(a.calendarSummary.lastSyncedAt).toLocaleString():'Never'}</strong></article></div><section className="panel"><div className="response-row"><button className="primary" disabled={!a.calendarStatus.credentialsConfigured||a.pageLoading} onClick={a.connectCalendar}>Connect Google Calendar</button><button disabled={!a.calendarStatus.connected||a.pageLoading} onClick={a.refreshCalendars}>Refresh Calendars</button><button disabled={!a.calendarStatus.connected||a.syncing} onClick={a.loadEvents}>{a.syncing?'Syncing…':'Sync Now'}</button>{a.calendarStatus.connected&&<button onClick={a.disconnectCalendar}>Disconnect</button>}</div>{!a.calendarStatus.credentialsConfigured&&<p className="muted">Place the Desktop OAuth client in app data as google-credentials.json to connect.</p>}</section>{a.calendarStatus.connected&&<><section className="panel"><h2>Calendars to synchronize</h2><div className="calendar-options">{a.calendars.map(c=><label className="check-setting calendar-option" key={c.syncId}><input type="checkbox" checked={a.selectedCalendarIds.includes(c.syncId)} onChange={e=>a.toggleCalendar(c.syncId,e.target.checked)}/><span><strong>{c.name}{c.primary?' · Primary':''}</strong><small>{c.id} · {c.accessRole}</small></span></label>)}</div><div className="date-time-row"><label>From<input type="date" value={a.syncRange.from} onChange={e=>a.setSyncRange({...a.syncRange,from:e.target.value})}/></label><label>Through<input type="date" value={a.syncRange.to} onChange={e=>a.setSyncRange({...a.syncRange,to:e.target.value})}/></label></div></section><section className="panel"><h2>Upcoming calendar events · {a.currentYear}</h2>{a.visibleCalendarEvents.length?a.visibleCalendarEvents.slice(0,50).map(ev=><article className="event-row calendar-event" key={`${ev.calendar_id}:${ev.google_event_id}`}><div><strong>{ev.title}</strong><small>{eventTimeLabel(ev)} · {ev.event_status}</small></div></article>):<p className="empty-state">No imported events for this year.</p>}</section></>}</>}
    {a.page === 'history' && <><div className="welcome-row"><div><h2>Reminder history</h2><p>Past completions and reminder actions recorded in the local database.</p></div><button onClick={()=>window.avatarApp.taskHistory().then(a.setHistory).catch(e=>a.setError(e.message))}>Refresh</button></div><section className="panel">{a.history.length?a.history.map((item,i)=><article className="history-row" key={item.id||i}><span className="done-icon">✓</span><div><strong>{item.title||item.task_title||'Reminder action'}</strong><small>{item.event_type||item.action||'Updated'} · {item.occurred_at?new Date(item.occurred_at).toLocaleString():''}</small></div></article>):<p className="empty-state">No reminder history yet.</p>}</section></>}
    {a.page === 'settings' && <><div className="welcome-row"><div><h2>Application preferences</h2><p>Your settings are stored locally and apply immediately where supported.</p></div></div><section className="panel settings-section"><div className="eyebrow">AVATAR</div><h2>Character settings</h2>{toggle('avatarEnabled','Enable 3D Avatar','Show the animated character on reminder overlays')}<div className="settings-control-grid"><label>Position<select value={a.settings.avatarPosition} onChange={e=>a.updateSetting('avatarPosition',e.target.value)}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label><label>Size<select value={a.settings.avatarSize} onChange={e=>a.updateSetting('avatarSize',e.target.value)}><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select></label><label>Animation speed<input type="number" min="0.5" max="2" step="0.1" value={a.settings.animationSpeed} onChange={e=>a.updateSetting('animationSpeed',Number(e.target.value))}/></label></div>{toggle('walkingAnimationEnabled','Walking animation','Use the walk cycle on entry and exit')}{toggle('reactionAnimationsEnabled','Reaction animations','Play available gestures after a response')}</section><section className="panel settings-section"><div className="eyebrow">SPEECH</div><h2>Voice settings</h2>{toggle('speakReminders','Speak reminders','Read reminder text aloud after the board appears')}<div className="settings-control-grid"><label>Voice<select value={a.settings.speechVoice||''} onChange={e=>a.updateSetting('speechVoice',e.target.value)}><option value="">System default</option>{a.speechVoices.map(v=><option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}</select></label><label>Volume<input type="range" min="0" max="1" step="0.05" value={a.settings.speechVolume} onChange={e=>a.updateSetting('speechVolume',Number(e.target.value))}/></label><label>Rate<input type="range" min="0.5" max="2" step="0.1" value={a.settings.speechRate} onChange={e=>a.updateSetting('speechRate',Number(e.target.value))}/></label></div><button onClick={a.testVoice}>Test voice</button></section><section className="panel settings-section"><div className="eyebrow">NOTIFICATIONS</div><h2>Notification settings</h2>{toggle('visualReminders','Visual reminders','Show reminder overlays')}{toggle('alwaysOnTopOverlay','Always on top','Keep overlay above other windows')}{toggle('enableSound','Sound','Play an alert sound') }<div className="settings-control-grid">{control('Default snooze (minutes)','defaultSnoozeMinutes','number',{min:1,max:240})}{control('Display duration (seconds, 0 = manual)','notificationDisplayDurationSeconds','number',{min:0,max:600})}</div></section><section className="panel settings-section"><div className="eyebrow">REMINDER DEFAULTS</div><h2>Scheduling</h2><div className="settings-control-grid">{control('Default interval (minutes)','defaultReminderIntervalMinutes','number',{min:1,max:1440})}{control('Active from','defaultActiveStart','time')}{control('Active until','defaultActiveEnd','time')}<label>Default recurrence<select value={a.settings.defaultRecurringBehavior} onChange={e=>a.updateSetting('defaultRecurringBehavior',e.target.value)}><option value="none">None</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><label>Missed reminder handling<select value={a.settings.missedReminderHandling} onChange={e=>a.updateSetting('missedReminderHandling',e.target.value)}><option value="skip">Skip missed occurrences</option><option value="notify_once">Notify once</option></select></label></div></section><section className="panel settings-section"><div className="eyebrow">GOOGLE CALENDAR</div><h2>Synchronization</h2>{toggle('syncCalendar','Ask before adding tasks to Google Calendar','Prompt before creating an event from a local reminder')}{toggle('autoSyncCalendar','Automatic synchronization','Sync selected calendars in the background')}<div className="settings-control-grid">{control('Sync interval (minutes)','calendarSyncIntervalMinutes','number',{min:5,max:120})}<label>Default calendar<select value={a.settings.defaultCalendarId||'primary'} onChange={e=>a.updateSetting('defaultCalendarId',e.target.value)}><option value="primary">Primary calendar</option>{a.calendars.map(c=><option key={c.syncId} value={c.syncId}>{c.name}</option>)}</select></label></div><button onClick={()=>a.setPage('googleCalendar')}>Manage calendars →</button></section><section className="panel settings-section"><div className="eyebrow">APPLICATION</div><h2>Startup and appearance</h2>{toggle('launchOnWindowsStartup','Launch on Windows startup','Start automatically when you sign in')}{toggle('minimizeToTray','Minimize to tray','Hide the window when minimized')}{toggle('startMinimized','Start minimized','Open the app in the tray')}{toggle('closeToTray','Close to tray','Keep running when window is closed')}<label>Theme<select value={a.settings.theme||'dark'} onChange={e=>a.updateSetting('theme',e.target.value)}><option value="dark">Dark</option><option value="light">Light</option></select></label></section></>}
    </div></section>
  </main>;
}
function parseVoiceDate(text) {
  const now = new Date(), m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i); if (!m) return null;
  let h = Number(m[1]) % 12; if (m[3].toLowerCase() === 'pm') h += 12; const minute = Number(m[2] || 0);
  const day = new Date(now); if (/tomorrow/i.test(text)) day.setDate(day.getDate()+1); else if (!/today/i.test(text)) return null;
  day.setHours(h, minute, 0, 0); return day.getTime() < now.getTime() ? null : day.toISOString();
}
createRoot(document.getElementById('root')).render(<App />);
