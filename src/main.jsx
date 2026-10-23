import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AvatarScene from './scene/AvatarScene.jsx';
import './styles.css';

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.96;
  utterance.pitch = 1.0;
  window.speechSynthesis.speak(utterance);
}

function App() {
  const [tasks, setTasks] = useState([]);
  const [activeReminder, setActiveReminder] = useState(null);
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [message, setMessage] = useState('');
  const [calendarStatus, setCalendarStatus] = useState({ connected: false, credentialsConfigured: false });
  const [events, setEvents] = useState([]);
  const [error, setError] = useState('');
  const [avatarState, setAvatarState] = useState('idle');

  async function refresh() {
    try {
      setTasks(await window.avatarApp.listTasks());
      setCalendarStatus(await window.avatarApp.calendarStatus());
    } catch (e) { setError(e.message); }
  }

  useEffect(() => {
    refresh();
    const unsubscribe = window.avatarApp.onReminder((task) => {
      setActiveReminder(task);
      setAvatarState('walkingIn');
      speak(task.message || `Hey! It's time for ${task.title}.`);
      setTimeout(() => setAvatarState('talking'), 900);
    });
    return unsubscribe;
  }, []);

  async function createTask(event) {
    event.preventDefault();
    setError('');
    try {
      const dueIso = dueAt ? new Date(dueAt).toISOString() : null;
      await window.avatarApp.createTask({ title, dueAt: dueIso, message, source: 'local' });
      setTitle(''); setDueAt(''); setMessage('');
      await refresh();
    } catch (e) { setError(e.message); }
  }

  async function respond(response) {
    if (!activeReminder) return;
    try {
      await window.avatarApp.respondToTask(activeReminder.id, response);
      if (response === 'done') speak('Great job! I marked that as done.');
      else if (response === 'snooze') speak('Okay. I will remind you again in 30 minutes.');
      else speak('Okay, I have recorded your response.');
      setAvatarState('walkingOut');
      setTimeout(() => setActiveReminder(null), 1000);
      await refresh();
    } catch (e) { setError(e.message); }
  }

  async function connectCalendar() {
    setError('');
    try {
      await window.avatarApp.connectCalendar();
      setCalendarStatus(await window.avatarApp.calendarStatus());
    } catch (e) { setError(e.message); }
  }

  async function loadEvents() {
    setError('');
    try { setEvents(await window.avatarApp.upcomingEvents()); }
    catch (e) { setError(e.message); }
  }

  async function syncTask(task) {
    setError('');
    try {
      await window.avatarApp.createCalendarEvent(task.id);
      await refresh();
      setError('Event created in Google Calendar.');
    } catch (e) { setError(e.message); }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div><div className="eyebrow">YOUR DESKTOP COMPANION</div><h1>Avatar Reminder</h1></div>
        <button className="icon-button" onClick={() => window.avatarApp.hideWindow()} aria-label="Hide window">—</button>
      </header>

      <section className={`avatar-panel state-${avatarState}`}>
        <AvatarScene state={avatarState} />
        <div className="speech-card">
          <strong>{activeReminder ? 'Hey, quick reminder!' : 'Ready when you are.'}</strong>
          <p>{activeReminder ? (activeReminder.message || `It's time for ${activeReminder.title}.`) : 'Add a task below. I will walk in when it is time.'}</p>
          {activeReminder && <div className="response-row">
            <button className="primary" onClick={() => respond('done')}>Yes, done</button>
            <button onClick={() => respond('snooze')}>Remind me later</button>
            <button className="quiet" onClick={() => respond('dismiss')}>Dismiss</button>
          </div>}
        </div>
      </section>

      <section className="panel">
        <h2>Create a reminder</h2>
        <form onSubmit={createTask} className="task-form">
          <label>Task title<input value={title} onChange={e => setTitle(e.target.value)} placeholder="Drink water" required /></label>
          <label>Reminder time<input type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)} /></label>
          <label>Message to show or speak<input value={message} onChange={e => setMessage(e.target.value)} placeholder="Hey! Have you had some water?" /></label>
          <button className="primary" type="submit">Add reminder</button>
        </form>
      </section>

      <section className="panel">
        <div className="section-heading"><h2>Your tasks</h2><button onClick={refresh}>Refresh</button></div>
        <div className="task-list">
          {tasks.length === 0 && <p className="muted">No tasks yet. Add your first reminder above.</p>}
          {tasks.map(task => <article className="task-row" key={task.id}>
            <div className="task-copy"><strong>{task.title}</strong><small>{task.due_at ? new Date(task.due_at).toLocaleString() : 'No time set'} · {task.status}</small></div>
            {task.due_at && !task.google_event_id && <button onClick={() => syncTask(task)}>Add to Calendar</button>}
            {task.google_event_id && <span className="synced">Calendar synced</span>}
          </article>)}
        </div>
      </section>

      <section className="panel calendar-panel">
        <div className="section-heading"><h2>Google Calendar</h2><span className={calendarStatus.connected ? 'status good' : 'status'}>{calendarStatus.connected ? 'Connected' : 'Not connected'}</span></div>
        {!calendarStatus.credentialsConfigured && <p className="muted">Add your Google OAuth credentials to the app data folder to enable connection.</p>}
        <div className="response-row">
          <button className="primary" onClick={connectCalendar} disabled={!calendarStatus.credentialsConfigured}>Connect Google</button>
          <button onClick={loadEvents} disabled={!calendarStatus.connected}>Load upcoming events</button>
        </div>
        {events.map(event => <div className="event-row" key={event.id}><strong>{event.title}</strong><small>{event.start ? new Date(event.start).toLocaleString() : 'All-day event'}</small></div>)}
      </section>
      {error && <div className="notice">{error}</div>}
      <footer>Local-first · SQLite storage · Google Calendar is optional</footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
