const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('markensDesktop', {
  isDesktopApp: true,
  platform: process.platform,
  version: '31.21.0',
  buildTs: 1801500000000,
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
  onUpdaterStatus: (cb) => {
    ipcRenderer.removeAllListeners('markens:updater-status');
    ipcRenderer.on('markens:updater-status', (_e, statusObj) => cb(statusObj));
  },
  checkForUpdates: () => ipcRenderer.invoke('markens:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('markens:download-update'),
  quitAndInstall: () => ipcRenderer.invoke('markens:quit-and-install'),
  onOtaReady: (cb) => {
    ipcRenderer.removeAllListeners('markens:ota-ready');
    ipcRenderer.on('markens:ota-ready', (_e, info) => cb(info));
  },
  onOtaProgress: (cb) => {
    ipcRenderer.removeAllListeners('markens:ota-progress');
    ipcRenderer.on('markens:ota-progress', (_e, prog) => cb(prog));
  },
  checkNativeOtaNow: () => ipcRenderer.invoke('markens:check-native-ota'),
  getActiveBuildInfo: () => ipcRenderer.invoke('markens:get-active-build-info'),
  confirmOtaBootHealthy: (info) => ipcRenderer.send('markens:confirm-ota-healthy', info),
  applyUpdateAndRestart: (rel) => ipcRenderer.send('markens:apply-update', rel),
  reloadToLatestOta: () => ipcRenderer.send('markens:reload-ota'),
  notifyIncomingCall: (payload) => ipcRenderer.send('markens:incoming-call', payload),
  clearCallAttention: () => ipcRenderer.send('markens:clear-call-attention')
});
