const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('markensDesktop', {
  isDesktopApp: true,
  platform: process.platform,
  version: '30.1.0',
  onToggleMic: (cb) => {
    ipcRenderer.removeAllListeners('markens:toggle-mic');
    ipcRenderer.on('markens:toggle-mic', () => cb());
  },
  onToggleDeaf: (cb) => {
    ipcRenderer.removeAllListeners('markens:toggle-deaf');
    ipcRenderer.on('markens:toggle-deaf', () => cb());
  },
  onToggleOverlay: (cb) => {
    ipcRenderer.removeAllListeners('markens:toggle-overlay');
    ipcRenderer.on('markens:toggle-overlay', () => cb());
  },
  onGameDetected: (cb) => {
    ipcRenderer.removeAllListeners('markens:game-detected');
    ipcRenderer.on('markens:game-detected', (_e, game) => cb(game));
  },
  applyUpdateAndRestart: (rel) => ipcRenderer.send('markens:apply-update', rel)
});
