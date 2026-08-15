const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onTriggerCapture: (cb) => ipcRenderer.on('trigger-capture', (_e, args) => cb(args)),
  sendCaptureResult: (payload) => ipcRenderer.invoke('capture:result', payload),

  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  openStorage: () => ipcRenderer.invoke('config:openStorage'),

  startCapture: () => ipcRenderer.invoke('capture:start'),
  stopCapture: () => ipcRenderer.invoke('capture:stop'),
  captureStatus: () => ipcRenderer.invoke('capture:status'),
  triggerNow: () => ipcRenderer.invoke('capture:triggerNow'),
  ipLocation: () => ipcRenderer.invoke('location:ip'),
  windowsNativeLocation: () => ipcRenderer.invoke('location:windows-native'),
  reverseGeocode: (payload) => ipcRenderer.invoke('location:reverse', payload)
});
