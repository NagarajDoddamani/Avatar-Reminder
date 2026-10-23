const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('avatarApp', {
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  createTask: (task) => ipcRenderer.invoke('tasks:create', task),
  respondToTask: (id, response) => ipcRenderer.invoke('tasks:respond', { id, response }),
  calendarStatus: () => ipcRenderer.invoke('calendar:status'),
  connectCalendar: () => ipcRenderer.invoke('calendar:connect'),
  listCalendars: () => ipcRenderer.invoke('calendar:list'),
  importedCalendarEvents: () => ipcRenderer.invoke('calendar:events-local'),
  syncCalendars: (options) => ipcRenderer.invoke('calendar:sync', options),
  createCalendarEvent: (taskId) => ipcRenderer.invoke('calendar:create-event', taskId),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testReminder: () => ipcRenderer.invoke('app:test-reminder'),
  dismissOverlay: () => ipcRenderer.invoke('overlay:dismiss'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  showWindow: () => ipcRenderer.invoke('window:show'),
  onReminder: (callback) => {
    const listener = (_event, task) => callback(task);
    ipcRenderer.on('reminder:fire', listener);
    return () => ipcRenderer.removeListener('reminder:fire', listener);
  },
  onTasksChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('tasks:changed', listener);
    return () => ipcRenderer.removeListener('tasks:changed', listener);
  }
});
