const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('avatarApp', {
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  createTask: (task) => ipcRenderer.invoke('tasks:create', task),
  respondToTask: (id, response) => ipcRenderer.invoke('tasks:respond', { id, response }),
  calendarStatus: () => ipcRenderer.invoke('calendar:status'),
  connectCalendar: () => ipcRenderer.invoke('calendar:connect'),
  upcomingEvents: () => ipcRenderer.invoke('calendar:upcoming'),
  createCalendarEvent: (taskId) => ipcRenderer.invoke('calendar:create-event', taskId),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  showWindow: () => ipcRenderer.invoke('window:show'),
  onReminder: (callback) => {
    const listener = (_event, task) => callback(task);
    ipcRenderer.on('reminder:fire', listener);
    return () => ipcRenderer.removeListener('reminder:fire', listener);
  }
});
