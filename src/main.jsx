import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AvatarScene from './scene/AvatarScene.jsx';
import './styles.css';

const isOverlay = window.location.hash === '#avatar';
function speak(text, settings, onStart, onEnd) {
  if (!settings?.speakReminders || !('speechSynthesis' in window)) return null;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = Number(settings.speechRate) || 0.96;
  utterance.volume = Number(settings.speechVolume ?? 0.85);
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
  const [title, setTitle] = useState(''), [date, setDate] = useState(''), [time, setTime] = useState(''), [message, setMessage] = useState('');
  const [settings, setSettings] = useState({ speakReminders: false, syncCalendar: true, quietStart: '', quietEnd: '', speechVolume: 0.85, speechRate: 0.96, avatarEnabled: true });
  useEffect(() => { activeRef.current = active; }, [active]);
  const [settingsLoaded, setSettingsLoaded] = useState(false), [presentationPhase, setPresentationPhase] = useState('hidden'), [isResponding, setIsResponding] = useState(false);
  const [arrivalReady, setArrivalReady] = useState(false), [exitReady, setExitReady] = useState(false);
  const [page, setPage] = useState('reminders'), [basicNeeds, setBasicNeeds] = useState([]), [basicForm, setBasicForm] = useState(null), [basicSaving, setBasicSaving] = useState(false);
  const presentationRef = useRef({ id: null, arrived: false, walkFinished: false, exitWindowFinished: false, exitWalkFinished: false });
  const spokenReminderIds = useRef(new Set());
  const chimedReminderIds = useRef(new Set());
  const [calendarStatus, setCalendarStatus] = useState({ connected: false, credentialsConfigured: false }), [events, setEvents] = useState([]), [error, setError] = useState(''), [notice, setNotice] = useState(''), [listening, setListening] = useState(false), [taskFilter, setTaskFilter] = useState('upcoming');
  const [calendars, setCalendars] = useState([]), [selectedCalendarIds, setSelectedCalendarIds] = useState([]), [syncRange, setSyncRange] = useState(() => { const start = new Date(); start.setDate(start.getDate() - 30); const end = new Date(); end.setDate(end.getDate() + 365); return { from: dateInputValue(start), to: dateInputValue(end) }; }), [syncing, setSyncing] = useState(false);
  const refresh = async () => { try { setTasks(await window.avatarApp.listTasks()); setCalendarStatus(await window.avatarApp.calendarStatus()); setSettings(await window.avatarApp.getSettings()); setSettingsLoaded(true); } catch (e) { setError(e.message); } };
  async function loadBasicNeeds() {
    try { setBasicNeeds(await window.avatarApp.listBasicNeeds()); }
    catch (e) { setError(`Could not load Basic Needs reminders: ${e.message}`); }
  }
  useEffect(() => { if (page === 'basicNeeds') loadBasicNeeds(); }, [page, tasks]);
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
    if (!isOverlay || presentationPhase !== 'presenting' || !active || !settingsLoaded || !settings.speakReminders || active.speak_enabled === 0) return;
    const id = String(active.id);
    if (spokenReminderIds.current.has(id)) return;
    spokenReminderIds.current.add(id);
    speak(reminderSpeech(active), settings,
      () => setPresentationPhase(current => current === 'presenting' ? 'talking' : current),
      () => setPresentationPhase(current => current === 'talking' ? 'presenting' : current));
  }, [isOverlay, presentationPhase, active, settingsLoaded, settings.speakReminders]);
  useEffect(() => {
    if (!isOverlay || presentationPhase !== 'presenting' || !active || active.sound_enabled !== 1) return;
    const id = String(active.id);
    if (chimedReminderIds.current.has(id)) return;
    chimedReminderIds.current.add(id);
    try { playReminderChime(); } catch (e) { console.warn('[reminder-sound] unavailable:', e.message); }
  }, [isOverlay, presentationPhase, active]);
  useEffect(() => { if (isOverlay && !settings.speakReminders) window.speechSynthesis?.cancel(); }, [isOverlay, settings.speakReminders]);
  useEffect(() => {
    if (!calendarStatus.connected || isOverlay) return;
    (async () => {
      try {
        const [available, saved, imported] = await Promise.all([window.avatarApp.listCalendars(), window.avatarApp.getSettings(), window.avatarApp.importedCalendarEvents()]);
        setCalendars(available); setEvents(imported);
        const ids = (saved.calendarIds || []).filter(id => available.some(c => c.syncId === id));
        setSelectedCalendarIds(ids.length ? ids : available.filter(c => c.primary).map(c => c.syncId));
      } catch (e) { setError(e.message); }
    })();
  }, [calendarStatus.connected]);
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
      const task = await window.avatarApp.createTask({ title, dueAt, message });
      if (dueAt && calendarStatus.connected) {
        const addToCalendar = !settings.syncCalendar || window.confirm('Add this reminder to your Google Calendar?');
        if (addToCalendar) await window.avatarApp.createCalendarEvent(task.id);
      }
      setTitle(''); setDate(''); setTime(''); setMessage(''); await refresh(); setNotice('Reminder saved.');
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
  async function updateSetting(key, value) { const next = { ...settings, [key]: value }; setSettings(next); try { await window.avatarApp.saveSettings({ [key]: value }); } catch (e) { setError(e.message); } }
  async function connectCalendar() { setError(''); try { await window.avatarApp.connectCalendar(); await refresh(); } catch (e) { setError(e.message); } }
  function editBasicReminder(reminder = null) {
    if (!reminder) {
      setBasicForm({ id: null, title: '', message: '', repeatMode: '30', customInterval: 90, startTime: '09:00', endTime: '21:00', activeDays: [0,1,2,3,4,5,6], enabled: false, soundEnabled: false, speakEnabled: true });
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
      const summary = `${result.calendarsChecked} calendar(s) checked · ${result.eventsRetrieved} retrieved · ${result.eventsAdded} added · ${result.eventsUpdated} updated`;
      if (result.success) setNotice(`Sync complete: ${summary}.`);
      else setError(`Sync incomplete: ${summary}. ${result.errors.map(item => `${item.calendarId}: ${item.message}`).join(' ')}`);
    } catch (e) { setError(`Sync failed: ${e.message}`); }
    finally { setSyncing(false); }
  }
  async function syncTask(task) { setError(''); try { await window.avatarApp.createCalendarEvent(task.id); await refresh(); setNotice('Event created in Google Calendar.'); } catch (e) { setError(e.message); } }
  const currentYear = new Date().getFullYear();
  const visibleTasks = tasks.filter(task => {
    if (taskFilter === 'all') return true;
    if (taskFilter === 'upcoming') {
      if (!['scheduled', 'snoozed'].includes(task.lifecycle_status)) return false;
      if (task.source !== 'google_calendar') return true;
      const eventDate = task.event_start_at || task.scheduled_reminder_at || task.due_at;
      return Boolean(eventDate) && new Date(eventDate).getFullYear() === currentYear;
    }
    if (taskFilter === 'due') return ['due', 'notified'].includes(task.lifecycle_status);
    if (taskFilter === 'completed') return ['completed', 'archived'].includes(task.lifecycle_status);
    return false;
  });
  const visibleCalendarEvents = events.filter(event => event.start_at && new Date(event.start_at).getFullYear() === currentYear);
  const intervalLabel = reminder => reminder.interval_minutes == null ? 'Once per active day' : `Every ${reminder.interval_minutes} minutes`;
  if (isOverlay) return <main className="overlay-shell"><div className="overlay-character"><AvatarScene state={presentationPhase} arrivalReady={arrivalReady} exitReady={exitReady} onAnimationComplete={onAvatarAnimationComplete} onError={message => console.error('[avatar-renderer]', message)} /></div>{active && ['board_entering', 'presenting', 'talking'].includes(presentationPhase) && <section className={`overlay-card${presentationPhase === 'board_entering' ? ' board-entering' : ''}`} onAnimationEnd={onBoardAnimationEnd} aria-live="polite"><div className="overlay-kicker">AVATAR REMINDER</div><h2>{active.title}</h2><small className="overlay-time">Scheduled · {reminderTime(active)}</small><p>{active.message || 'Your reminder is due.'}</p><div className="response-row"><button className="primary" disabled={isResponding} onClick={() => respond('done')}>Done</button><button disabled={isResponding} onClick={() => respond('snooze')}>Snooze / Later</button><button className="quiet" disabled={isResponding} onClick={() => respond('dismiss')}>Dismiss</button></div></section>}</main>;
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
function parseVoiceDate(text) {
  const now = new Date(), m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i); if (!m) return null;
  let h = Number(m[1]) % 12; if (m[3].toLowerCase() === 'pm') h += 12; const minute = Number(m[2] || 0);
  const day = new Date(now); if (/tomorrow/i.test(text)) day.setDate(day.getDate()+1); else if (!/today/i.test(text)) return null;
  day.setHours(h, minute, 0, 0); return day.getTime() < now.getTime() ? null : day.toISOString();
}
createRoot(document.getElementById('root')).render(<App />);
