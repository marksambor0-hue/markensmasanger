const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { fileURLToPath } = require('url');
const { EventEmitter } = require('events');

// В режиме автотестов (MARKENS_TEST_MODE=1) не требуем бинарник electron, чтобы проверять логику через Node.js
const IS_TEST_MODE = process.env.MARKENS_TEST_MODE === '1';
const electronModule = IS_TEST_MODE ? {} : require('electron');
const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  session,
  desktopCapturer,
  dialog,
  ipcMain,
  shell
} = electronModule;

let autoUpdater = null;
if (!IS_TEST_MODE) {
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (_e) {
    autoUpdater = null;
  }
}

function readBundledVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.version === 'string') {
      return `v${pkg.version.replace(/^v/i, '')}`;
    }
  } catch (_e) {}
  return 'v31.0.0';
}

const BUNDLED_VERSION = readBundledVersion();
const GITHUB_RELEASES_URL = 'https://github.com/marksambor0-hue/markensmasanger/releases/latest';
const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'notifications', 'fullscreen']);
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 минут

// A file:// URL alone is not trusted: only the real app entry page may request permissions.
function isTrustedAppUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'file:') return false;
    return path.resolve(fileURLToPath(parsed)) === path.resolve(__dirname, 'index.html');
  } catch (_error) {
    return false;
  }
}

function getWebContentsUrl(webContents) {
  try {
    return webContents && typeof webContents.getURL === 'function' ? webContents.getURL() : '';
  } catch (_error) {
    return '';
  }
}

function isAllowedPermissionRequest(webContents, permission, requestingUrl) {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false;
  const topLevelUrl = getWebContentsUrl(webContents);
  if (!isTrustedAppUrl(topLevelUrl)) return false;
  const originUrl = typeof requestingUrl === 'string' && requestingUrl ? requestingUrl : topLevelUrl;
  return isTrustedAppUrl(originUrl);
}

function isAllowedPermissionCheck(webContents, permission, requestingOrigin, details = {}) {
  if (!ALLOWED_PERMISSIONS.has(permission) || !webContents) return false;
  if (details && details.isMainFrame === false) return false;
  if (!isTrustedAppUrl(getWebContentsUrl(webContents))) return false;
  if (typeof details.requestingUrl === 'string' && details.requestingUrl) {
    return isTrustedAppUrl(details.requestingUrl);
  }
  try {
    return new URL(String(requestingOrigin || '')).protocol === 'file:';
  } catch (_error) {
    return false;
  }
}

if (app && typeof app.setAppUserModelId === 'function') {
  app.setAppUserModelId('com.markens.messenger');
}

// Аппаратное ускорение WebRTC, эхоподавления и минимальной задержки звука в Chromium
if (app && app.commandLine && typeof app.commandLine.appendSwitch === 'function') {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('enable-features', 'WebRtcHideLocalIpsWithMdns,AudioServiceOutOfProcess');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

function parseSemVer(verStr) {
  if (!verStr || typeof verStr !== 'string') return null;
  const cleaned = verStr.trim().replace(/^v/i, '');
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const parts = cleaned.split('.').map((n) => parseInt(n, 10));
  while (parts.length < 3) parts.push(0);
  if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 999999)) return null;
  return parts;
}

function compareVersions(vA, vB) {
  const a = parseSemVer(vA);
  const b = parseSemVer(vB);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function normalizeVersionTag(verStr) {
  const parsed = parseSemVer(verStr);
  if (!parsed) return null;
  return `v${parsed.join('.')}`;
}

function formatUpdaterError(err) {
  const raw = err && err.message ? String(err.message) : String(err || 'Неизвестная ошибка обновления');
  if (/net::ERR_INTERNET_DISCONNECTED|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN/i.test(raw)) {
    return 'Нет подключения к интернету или сервер GitHub временно недоступен';
  }
  if (/404|Cannot find latest\.yml|Unable to find latest version/i.test(raw)) {
    return 'В GitHub Releases пока нет опубликованного файла latest.yml';
  }
  if (/sha512|checksum|integrity/i.test(raw)) {
    return 'Контрольная сумма SHA-512 установщика не совпала (загрузка повреждена и заблокирована)';
  }
  return raw;
}

/**
 * Контроллер автообновления MARKENS через electron-updater и GitHub Releases.
 */
class MarkensUpdaterService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.currentVersion = normalizeVersionTag(options.currentVersion || BUNDLED_VERSION) || 'v31.0.0';
    this.updater = options.updater !== undefined ? options.updater : autoUpdater;
    this.isPackaged = options.isPackaged !== undefined ? Boolean(options.isPackaged) : Boolean(app && app.isPackaged);
    this.onBeforeQuitAndInstall = typeof options.onBeforeQuitAndInstall === 'function' ? options.onBeforeQuitAndInstall : null;

    this.state = {
      status: 'idle',
      currentVersion: this.currentVersion,
      availableVersion: null,
      downloadedVersion: null,
      downloadPercent: 0,
      lastCheckTs: 0,
      releaseNotes: '',
      lastError: null,
      updaterActive: Boolean(this.updater)
    };

    this._checkInFlight = false;
    this.downloadFinalizeTimeoutMs = Number.isFinite(options.downloadFinalizeTimeoutMs) && options.downloadFinalizeTimeoutMs > 0
      ? options.downloadFinalizeTimeoutMs
      : 30000;
    this._downloadFinalizeTimer = null;
    this._bindUpdaterEvents();
  }

  _clearDownloadFinalizeTimer() {
    if (this._downloadFinalizeTimer) {
      clearTimeout(this._downloadFinalizeTimer);
      this._downloadFinalizeTimer = null;
    }
  }

  _scheduleDownloadFinalizeWatchdog() {
    this._clearDownloadFinalizeTimer();
    this._downloadFinalizeTimer = setTimeout(() => {
      this._downloadFinalizeTimer = null;
      if (this.state.status !== 'downloading' || this.state.downloadPercent < 100) return;
      const message = 'Загрузка достигла 100%, но установщик не подтвердил завершение. Повторите проверку обновлений.';
      this.state.status = 'error';
      this.state.lastError = message;
      this._emitStatus({ event: 'error', error: message });
    }, this.downloadFinalizeTimeoutMs);
    if (this._downloadFinalizeTimer && typeof this._downloadFinalizeTimer.unref === 'function') {
      this._downloadFinalizeTimer.unref();
    }
  }

  _bindUpdaterEvents() {
    if (!this.updater) return;

    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = true;
    this.updater.allowDowngrade = false;
    this.updater.allowPrerelease = false;

    this.updater.on('checking-for-update', () => {
      this._clearDownloadFinalizeTimer();
      this.state.status = 'checking';
      this.state.lastCheckTs = Date.now();
      this.state.lastError = null;
      this._emitStatus({
        event: 'checking',
        currentVersion: this.currentVersion,
        message: 'Проверка обновлений в GitHub Releases...'
      });
    });

    this.updater.on('update-available', (info) => {
      const candidateVer = normalizeVersionTag(info && info.version);
      if (!candidateVer || compareVersions(candidateVer, this.currentVersion) <= 0) {
        this.state.status = 'not-available';
        this._emitStatus({
          event: 'not-available',
          version: this.currentVersion,
          reason: 'Версия в релизе не новее установленной'
        });
        return;
      }

      this.state.status = 'available';
      this.state.availableVersion = candidateVer;
      this.state.releaseNotes = info && typeof info.releaseNotes === 'string' ? info.releaseNotes : '';
      this.state.lastError = null;
      this._emitStatus({
        event: 'available',
        version: candidateVer,
        releaseNotes: this.state.releaseNotes
      });
    });

    this.updater.on('update-not-available', () => {
      this._clearDownloadFinalizeTimer();
      this.state.status = 'not-available';
      this.state.availableVersion = null;
      this.state.lastCheckTs = Date.now();
      this._emitStatus({
        event: 'not-available',
        version: this.currentVersion
      });
    });

    this.updater.on('download-progress', (prog) => {
      const pct = prog && typeof prog.percent === 'number' ? Math.max(0, Math.min(100, Math.round(prog.percent))) : 0;
      this.state.status = 'downloading';
      this.state.downloadPercent = pct;
      if (pct >= 100) this._scheduleDownloadFinalizeWatchdog();
      else this._clearDownloadFinalizeTimer();
      this._emitStatus({
        event: 'download-progress',
        version: this.state.availableVersion,
        percent: pct
      });
    });

    this.updater.on('update-downloaded', (info) => {
      this._clearDownloadFinalizeTimer();
      const dlVer = normalizeVersionTag((info && info.version) || this.state.availableVersion);
      if (!dlVer || compareVersions(dlVer, this.currentVersion) <= 0) {
        this.state.status = 'not-available';
        this.state.downloadedVersion = null;
        this.state.lastCheckTs = Date.now();
        this._emitStatus({
          event: 'not-available',
          version: this.currentVersion,
          reason: 'Загрузка завершилась, но версия не новее установленной'
        });
        return;
      }

      this.state.status = 'downloaded';
      this.state.availableVersion = dlVer;
      this.state.downloadedVersion = dlVer;
      this.state.downloadPercent = 100;
      this.state.lastError = null;
      this._emitStatus({
        event: 'downloaded',
        version: dlVer,
        releaseNotes: this.state.releaseNotes,
        isNativeInstaller: true
      });
    });

    this.updater.on('error', (err) => {
      this._clearDownloadFinalizeTimer();
      const friendly = formatUpdaterError(err);
      this.state.status = 'error';
      this.state.lastError = friendly;
      this._emitStatus({
        event: 'error',
        error: friendly
      });
    });
  }

  _emitStatus(payload) {
    this.emit('status', {
      ...payload,
      diagnostics: this.getDiagnostics()
    });
  }

  getDiagnostics() {
    return {
      bundledVersion: this.currentVersion,
      activeVersion: this.currentVersion,
      availableVersion: this.state.availableVersion,
      downloadedVersion: this.state.downloadedVersion,
      status: this.state.status,
      downloadPercent: this.state.downloadPercent,
      lastCheckTs: this.state.lastCheckTs,
      lastError: this.state.lastError,
      releaseNotes: this.state.releaseNotes,
      electronUpdaterAvailable: Boolean(this.updater),
      isPackaged: this.isPackaged,
      releasesUrl: GITHUB_RELEASES_URL
    };
  }

  async checkForUpdates() {
    if (!this.updater) {
      return {
        ok: false,
        code: 'UPDATER_UNAVAILABLE',
        error: 'Модуль electron-updater активен только в установленном Windows-приложении (.exe)'
      };
    }
    if (!this.isPackaged) {
      return {
        ok: false,
        code: 'DEV_MODE',
        error: 'Автообновление проверяет GitHub Releases только в собранном приложении MARKENS_Setup.exe'
      };
    }
    if (this._checkInFlight) {
      return {
        ok: true,
        status: this.state.status,
        message: 'Проверка обновлений уже выполняется'
      };
    }

    this._checkInFlight = true;
    try {
      this.state.lastCheckTs = Date.now();
      const res = await this.updater.checkForUpdates();
      const remoteVer = res && res.updateInfo && res.updateInfo.version
        ? normalizeVersionTag(res.updateInfo.version)
        : null;
      return {
        ok: true,
        currentVersion: this.currentVersion,
        remoteVersion: remoteVer,
        updateAvailable: Boolean(remoteVer && compareVersions(remoteVer, this.currentVersion) > 0),
        status: this.state.status
      };
    } catch (err) {
      const friendly = formatUpdaterError(err);
      this.state.status = 'error';
      this.state.lastError = friendly;
      return {
        ok: false,
        code: 'CHECK_FAILED',
        error: friendly
      };
    } finally {
      this._checkInFlight = false;
    }
  }

  installDownloadedUpdate() {
    if (!this.updater) {
      return {
        ok: false,
        code: 'UPDATER_UNAVAILABLE',
        error: 'Установщик обновлений доступен только в Windows-приложении (.exe)'
      };
    }
    if (this.state.status !== 'downloaded' || !this.state.downloadedVersion) {
      return {
        ok: false,
        code: 'UPDATE_NOT_DOWNLOADED',
        error: 'Новая версия ещё не скачана. Подождите завершения загрузки из GitHub Releases.'
      };
    }
    if (compareVersions(this.state.downloadedVersion, this.currentVersion) <= 0) {
      return {
        ok: false,
        code: 'ALREADY_INSTALLED',
        error: `Версия ${this.state.downloadedVersion} уже установлена или не новее текущей (${this.currentVersion})`
      };
    }

    this.state.status = 'installing';
    if (this.onBeforeQuitAndInstall) {
      this.onBeforeQuitAndInstall();
    }
    this.updater.quitAndInstall(false, true);
    return {
      ok: true,
      mode: 'electron-updater',
      installedVersion: this.state.downloadedVersion
    };
  }
}

if (IS_TEST_MODE) {
  module.exports = {
    MarkensUpdaterService,
    parseSemVer,
    compareVersions,
    normalizeVersionTag,
    formatUpdaterError,
    isTrustedAppUrl,
    isAllowedPermissionRequest,
    isAllowedPermissionCheck,
    BUNDLED_VERSION,
    GITHUB_RELEASES_URL
  };
} else {
  let mainWindow = null;
  let tray = null;
  let isQuitting = false;
  let gameDetectInterval = null;
  let updateCheckInterval = null;
  let updaterService = null;

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
    const candidates = [
      path.join(__dirname, 'icon.ico'),
      path.join(__dirname, 'icon.png'),
      path.join(__dirname, 'assets', 'icon.ico'),
      path.join(__dirname, 'assets', 'icon.png')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }

  function sendUpdateStatusToWindow(payload) {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send('markens:update-status', payload);
    }
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
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        spellcheck: true
      }
    });

    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
    });

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const requestingUrl = details && typeof details.requestingUrl === 'string' ? details.requestingUrl : '';
      callback(isAllowedPermissionRequest(webContents, permission, requestingUrl));
    });

    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      return isAllowedPermissionCheck(webContents, permission, requestingOrigin, details || {});
    });

    // Do not grant screen capture to the first enumerated source automatically.
    // Require the trusted main frame, a user gesture, and an explicit source choice.
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const frame = request && request.frame;
        if (!frame || frame !== frame.top || !isTrustedAppUrl(frame.url) || request.userGesture !== true) {
          callback(null);
          return;
        }

        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        if (!sources || sources.length === 0 || !mainWindow || mainWindow.isDestroyed()) {
          callback(null);
          return;
        }

        const cancelIndex = sources.length;
        const choices = sources.map((source, index) => String(index + 1) + '. ' + source.name);
        choices.push('Отмена');
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          title: 'Демонстрация экрана MARKENS',
          message: 'Выбери, чем поделиться с собеседниками',
          detail: request.audioRequested
            ? 'При выборе источника также может передаваться системный звук, запрошенный в окне демонстрации.'
            : 'Передача начнётся только после выбора экрана или окна.',
          buttons: choices,
          defaultId: cancelIndex,
          cancelId: cancelIndex,
          noLink: true
        });

        const selectedSource = result && Number.isInteger(result.response) && result.response >= 0 && result.response < sources.length
          ? sources[result.response]
          : null;
        if (!selectedSource) {
          callback(null);
          return;
        }

        const selectedStreams = { video: selectedSource };
        if (request.audioRequested) selectedStreams.audio = 'loopback';
        callback(selectedStreams);
      } catch (error) {
        console.warn('Screen capture request was denied or cancelled:', error && error.message ? error.message : error);
        callback(null);
      }
    });

    mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
      if (!isTrustedAppUrl(targetUrl)) {
        event.preventDefault();
        if (/^https?:\/\//i.test(targetUrl)) {
          shell.openExternal(targetUrl).catch(() => {});
        }
      }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (!url || url === 'about:blank') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 560,
            height: 380,
            autoHideMenuBar: true,
            backgroundColor: '#0b0c0e',
            icon: getAppIconPath(),
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true
            }
          }
        };
      }
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('Renderer process gone:', details && details.reason);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadFile(path.join(__dirname, 'index.html')).catch(() => {});
        }
      }, 1000);
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.on('close', (event) => {
      if (!isQuitting) {
        event.preventDefault();
        mainWindow.hide();
      }
    });
  }

  function setupIpcHandlers() {
    ipcMain.handle('markens:get-update-diagnostics', async () => {
      return updaterService.getDiagnostics();
    });

    ipcMain.handle('markens:check-for-updates', async () => {
      return updaterService.checkForUpdates();
    });

    ipcMain.handle('markens:install-update', async () => {
      return updaterService.installDownloadedUpdate();
    });

    ipcMain.handle('markens:open-releases-page', async () => {
      await shell.openExternal(GITHUB_RELEASES_URL);
      return { ok: true, url: GITHUB_RELEASES_URL };
    });
  }

  function setupTray() {
    try {
      const iconPath = getAppIconPath();
      const trayIcon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
      tray = new Tray(trayIcon);
      const contextMenu = Menu.buildFromTemplate([
        {
          label: `Открыть MARKENS (${BUNDLED_VERSION})`,
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
          label: 'Проверить обновления (GitHub Releases)',
          click: () => {
            if (updaterService) updaterService.checkForUpdates();
          }
        },
        {
          label: 'Скачать установщик вручную (GitHub)',
          click: () => {
            shell.openExternal(GITHUB_RELEASES_URL).catch(() => {});
          }
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
      tray.setToolTip(`MARKENS ${BUNDLED_VERSION} — Голосовой и игровой мессенджер`);
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
    } catch (_e) {}
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
      execFile('tasklist.exe', ['/nh'], { windowsHide: true }, (err, stdout) => {
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

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.whenReady().then(() => {
    if (!gotTheLock) return;

    updaterService = new MarkensUpdaterService({
      currentVersion: BUNDLED_VERSION,
      updater: autoUpdater,
      isPackaged: app.isPackaged,
      onBeforeQuitAndInstall: () => {
        isQuitting = true;
      }
    });

    updaterService.on('status', (payload) => {
      sendUpdateStatusToWindow(payload);
    });

    setupIpcHandlers();
    createWindow();
    setupTray();
    setupGlobalHotkeys();
    startSteamProcessDetector();

    if (app.isPackaged && autoUpdater) {
      setTimeout(() => {
        updaterService.checkForUpdates().catch(() => {});
      }, 4500);

      updateCheckInterval = setInterval(() => {
        updaterService.checkForUpdates().catch(() => {});
      }, UPDATE_CHECK_INTERVAL_MS);
    }
  });

  app.on('will-quit', () => {
    if (gameDetectInterval) {
      clearInterval(gameDetectInterval);
      gameDetectInterval = null;
    }
    if (updateCheckInterval) {
      clearInterval(updateCheckInterval);
      updateCheckInterval = null;
    }
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
