const { contextBridge, ipcRenderer } = require('electron');

let appVersion = '31.0.0';
try {
  const pkg = require('./package.json');
  if (pkg && typeof pkg.version === 'string') {
    appVersion = pkg.version;
  }
} catch (_e) {}

contextBridge.exposeInMainWorld('markensDesktop', {
  isDesktopApp: true,
  platform: process.platform,
  version: appVersion,

  // Глобальные горячие клавиши и детектор игр Steam
  onToggleMic: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.removeAllListeners('markens:toggle-mic');
    ipcRenderer.on('markens:toggle-mic', () => cb());
  },
  onToggleDeaf: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.removeAllListeners('markens:toggle-deaf');
    ipcRenderer.on('markens:toggle-deaf', () => cb());
  },
  onToggleOverlay: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.removeAllListeners('markens:toggle-overlay');
    ipcRenderer.on('markens:toggle-overlay', () => cb());
  },
  onGameDetected: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.removeAllListeners('markens:game-detected');
    ipcRenderer.on('markens:game-detected', (_e, game) => cb(game));
  },

  // Управление автообновлением через electron-updater (GitHub Releases)
  onUpdateStatus: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.removeAllListeners('markens:update-status');
    ipcRenderer.on('markens:update-status', (_e, statusPayload) => cb(statusPayload));
  },
  getUpdateDiagnostics: () => ipcRenderer.invoke('markens:get-update-diagnostics'),
  checkForUpdates: () => ipcRenderer.invoke('markens:check-for-updates'),
  installUpdateNow: () => ipcRenderer.invoke('markens:install-update'),
  applyUpdateAndRestart: (rel) => ipcRenderer.invoke('markens:install-update', rel),
  openReleasesPage: () => ipcRenderer.invoke('markens:open-releases-page')
});
