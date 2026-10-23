const { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, session, desktopCapturer, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

app.setAppUserModelId('com.markens.messenger');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let gameDetectInterval = null;

// Single-instance lock: prevent multiple conflicting app windows
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

function getAppIconPath() {
  const icoPath = path.join(__dirname, 'assets', 'icon.ico');
  const pngPath = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(icoPath)) return icoPath;
  if (fs.existsSync(pngPath)) return pngPath;
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    title: 'MARKENS',
    backgroundColor: '#14161b',
    icon: getAppIconPath(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Automatically grant microphone, webcam, screen share, and notification permissions
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });

  session.defaultSession.setPermissionCheckHandler(() => true);

  // Enable 1080p/1440p 60FPS screen capture with loopback system audio
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      if (sources && sources.length > 0) {
        callback({ video: sources[0], audio: 'loopback' });
      } else {
        callback({});
      }
    }).catch(() => callback({}));
  });

  // Open external links in default OS browser while allowing internal popouts (about:blank)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 560,
          height: 380,
          autoHideMenuBar: true,
          backgroundColor: '#0b0c0e',
          icon: getAppIconPath()
        }
      };
    }
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Minimize to System Tray on window close so voice calls stay connected
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function setupTray() {
  try {
    const iconPath = getAppIconPath();
    const trayIcon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    tray = new Tray(trayIcon);
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Открыть MARKENS',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Микрофон Вкл/Выкл (Ctrl+Shift+M)',
        click: () => mainWindow && mainWindow.webContents.send('markens:toggle-mic')
      },
      {
        label: 'Звук Вкл/Выкл (Ctrl+Shift+D)',
        click: () => mainWindow && mainWindow.webContents.send('markens:toggle-deaf')
      },
      {
        label: 'Игровой оверлей (Ctrl+Shift+O)',
        click: () => mainWindow && mainWindow.webContents.send('markens:toggle-overlay')
      },
      { type: 'separator' },
      {
        label: 'Полный выход',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setToolTip('MARKENS v30.1 — Голосовой и игровой мессенджер');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.focus();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });
  } catch (e) {
    console.warn('Tray initialization skipped:', e);
  }
}

function setupGlobalHotkeys() {
  try {
    globalShortcut.register('CommandOrControl+Shift+M', () => {
      if (mainWindow) mainWindow.webContents.send('markens:toggle-mic');
    });
    globalShortcut.register('CommandOrControl+Shift+D', () => {
      if (mainWindow) mainWindow.webContents.send('markens:toggle-deaf');
    });
    globalShortcut.register('CommandOrControl+Shift+O', () => {
      if (mainWindow) mainWindow.webContents.send('markens:toggle-overlay');
    });
  } catch (e) {}
}

function startSteamProcessDetector() {
  if (process.platform !== 'win32') return;
  let lastGame = null;
  const gameMap = [
    { exe: 'cs2.exe', name: 'Counter-Strike 2' },
    { exe: 'deadlock.exe', name: 'Deadlock' },
    { exe: 'project8.exe', name: 'Deadlock' },
    { exe: 'discovery.exe', name: 'THE FINALS' },
    { exe: 'subnautica2.exe', name: 'Subnautica 2' },
    { exe: 'subnautica.exe', name: 'Subnautica 2' },
    { exe: 'dota2.exe', name: 'Dota 2' },
    { exe: 'valorant.exe', name: 'Valorant' },
    { exe: 'gta5.exe', name: 'Grand Theft Auto V' },
    { exe: 'rustclient.exe', name: 'Rust' },
    { exe: 'r5apex.exe', name: 'Apex Legends' },
    { exe: 'fortniteclient-win64-shipping.exe', name: 'Fortnite' },
    { exe: 'cyberpunk2077.exe', name: 'Cyberpunk 2077' }
  ];

  gameDetectInterval = setInterval(() => {
    exec('tasklist /nh', { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return;
      const lower = stdout.toLowerCase();
      let detected = null;
      for (const item of gameMap) {
        if (lower.includes(item.exe)) {
          detected = item.name;
          break;
        }
      }
      if (detected !== lastGame) {
        lastGame = detected;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('markens:game-detected', detected);
        }
      }
    });
  }, 5000);
}

ipcMain.on('markens:apply-update', (_event, rel) => {
  // Handled cleanly in renderer without infinite reload loops
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.whenReady().then(() => {
  if (!gotTheLock) return;
  createWindow();
  setupTray();
  setupGlobalHotkeys();
  startSteamProcessDetector();
});

app.on('will-quit', () => {
  if (gameDetectInterval) {
    clearInterval(gameDetectInterval);
    gameDetectInterval = null;
  }
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
