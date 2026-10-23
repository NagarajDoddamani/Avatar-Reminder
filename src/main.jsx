import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AvatarScene from './scene/AvatarScene.jsx';
import './styles.css';

const isOverlay = window.location.hash === '#avatar';
function speak(text, settings) {
  if (!settings?.speakReminders || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = Number(settings.speechRate) || 0.96;
  utterance.volume = Number(settings.speechVolume ?? 0.85);
  window.speechSynthesis.speak(utterance);
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
function App() {
  const [tasks, setTasks] = useState([]), [active, setActive] = useState(null);
  const [title, setTitle] = useState(''), [date, setDate] = useState(''), [time, setTime] = useState(''), [message, setMessage] = useState('');
  const [settings, setSettings] = useState({ speakReminders: false, syncCalendar: true, quietStart: '', quietEnd: '', speechVolume: 0.85, speechRate: 0.96, avatarEnabled: true });
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const [calendarStatus, setCalendarStatus] = useState({ connected: false, credentialsConfigured: false }), [events, setEvents] = useState([]), [error, setError] = useState(''), [notice, setNotice] = useState(''), [listening, setListening] = useState(false), [taskFilter, setTaskFilter] = useState('upcoming');
  const [calendars, setCalendars] = useState([]), [selectedCalendarIds, setSelectedCalendarIds] = useState([]), [syncRange, setSyncRange] = useState(() => { const start = new Date(); start.setDate(start.getDate() - 30); const end = new Date(); end.setDate(end.getDate() + 365); return { from: dateInputValue(start), to: dateInputValue(end) }; }), [syncing, setSyncing] = useState(false);
  const refresh = async () => { try { setTasks(await window.avatarApp.listTasks()); setCalendarStatus(await window.avatarApp.calendarStatus()); setSettings(await window.avatarApp.getSettings()); } catch (e) { setError(e.message); } };
  useEffect(() => {
    refresh();
    const unsub = window.avatarApp.onReminder(task => { setActive(task); if (isOverlay) speak(task.message || `It's time for ${task.title}.`, settingsRef.current); });
    return unsub;
  }, []);
  useEffect(() => window.avatarApp.onTasksChanged(refresh), []);
  useEffect(() => {
    if (!isOverlay) return;
    if (!settings.speakReminders) { window.speechSynthesis?.cancel(); return; }
    if (active) speak(active.message || `It's time for ${active.title}.`, settings);
  }, [settings.speakReminders]);
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
  async function respondTask(task, response) { try { await window.avatarApp.respondToTask(task.id, response); if (response === 'done' || isOverlay) speak(response === 'done' ? 'Great job! I marked that as done.' : response === 'snooze' ? 'Okay. I will remind you again in 30 minutes.' : 'Okay, I have recorded your response.', settings); if (active?.id === task.id || isOverlay) { await window.avatarApp.dismissOverlay(); setActive(null); } await refresh(); } catch (e) { setError(e.message); } }
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
  if (isOverlay) return <main className="overlay-shell"><div className="overlay-character"><AvatarScene state={active ? 'walkingIn' : 'idle'} /></div>{active && <section className="overlay-card"><strong>Hey, quick reminder!</strong><p>{active.message || `It's time for ${active.title}.`}</p><small>{active.title}</small><div className="response-row"><button className="primary" onClick={() => respond('done')}>Done</button><button onClick={() => respond('snooze')}>Remind me later</button><button className="quiet" onClick={() => respond('dismiss')}>Dismiss</button></div></section>}</main>;
  return <main className="app-shell">
    <header className="topbar"><div><div className="eyebrow">YOUR DESKTOP COMPANION</div><h1>Avatar Reminder</h1></div><div className="response-row"><button onClick={() => window.avatarApp.testReminder()}>Test reminder</button><button className="icon-button" onClick={() => window.avatarApp.hideWindow()} aria-label="Hide window">—</button></div></header>
    <section className="panel"><h2>Create a reminder</h2><form onSubmit={createTask} className="task-form"><label>Task title<div className="input-action"><input value={title} onChange={e => setTitle(e.target.value)} placeholder="Drink water" required /><button type="button" onClick={startVoice} aria-label="Speak a task">{listening ? 'Listening…' : '🎙 Mic'}</button></div></label><div className="date-time-row"><label>Reminder date<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label><label>Reminder time<input type="time" value={time} onChange={e => setTime(e.target.value)} /></label></div><label>Message shown on screen<input value={message} onChange={e => setMessage(e.target.value)} placeholder="Hey! Take a short break." /></label><button className="primary" type="submit">Add reminder</button></form></section>
    <section className="panel"><div className="section-heading"><h2>Your tasks</h2><button onClick={refresh}>Refresh</button></div><div className="task-filters">{['upcoming','due','completed','all'].map(filter => <button key={filter} className={taskFilter === filter ? 'selected' : ''} onClick={() => setTaskFilter(filter)}>{filter === 'upcoming' ? `Upcoming (${currentYear})` : filter[0].toUpperCase()+filter.slice(1)}</button>)}</div><div className="task-list">{visibleTasks.length === 0 && <p className="muted">No {taskFilter} tasks.</p>}{visibleTasks.map(task => { const remindAt = task.scheduled_reminder_at || task.due_at; const calendarName = calendars.find(item => item.syncId === task.calendar_id)?.name || task.calendar_id; return <article className="task-row" key={task.id}><div className="task-copy"><strong>{task.title}</strong><small>{task.source === 'google_calendar' ? 'Google Calendar' : 'Local Task'}{task.calendar_id ? ` · ${calendarName}` : ''} · {remindAt ? new Date(remindAt).toLocaleString() : 'No time set'} · {task.lifecycle_status || task.status}{task.all_day ? ` · All day (reminder ${settings.allDayReminderTime || '09:00'})` : ''}</small></div><div className="task-actions">{!['completed','archived','cancelled','dismissed'].includes(task.lifecycle_status) && <button onClick={() => respondTask(task,'done')}>Done</button>}{['notified','due'].includes(task.lifecycle_status) && <><button onClick={() => respondTask(task,'snooze')}>Snooze</button><button onClick={() => respondTask(task,'dismiss')}>Dismiss</button></>}{task.source !== 'google_calendar' && remindAt && !task.google_event_id && <button onClick={() => syncTask(task)}>Add to Calendar</button>}{task.google_event_id && <span className="synced">Calendar linked</span>}</div></article>; })}</div></section>
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
