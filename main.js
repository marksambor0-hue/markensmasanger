let electronMod = {};
try { electronMod = require('electron'); } catch (_e) {}
const { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, session, desktopCapturer, ipcMain, shell, Notification } = electronMod;
const path = require('path');
const fs = require('fs');
const https = require('https');
const { exec } = require('child_process');

const APP_BUNDLED_VERSION = '31.21.0';
const APP_BUNDLED_TS = 1801500000000;
const FIREBASE_OTA_DB = 'https://markenschatik-default-rtdb.europe-west1.firebasedatabase.app';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/marksambor0-hue/markensmasanger/main';
const NETLIFY_LIVE_INDEX = 'https://markensmesenger.netlify.app/index.html';

if (app && typeof app.setAppUserModelId === 'function') {
  app.setAppUserModelId('com.markens.messenger');
}
if (app && app.commandLine && typeof app.commandLine.appendSwitch === 'function') {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

function parseSemVerTuple(verStr) {
  if (!verStr || typeof verStr !== 'string') return [0, 0, 0];
  const clean = verStr.replace(/^v/i, '').trim().split('-')[0];
  const parts = clean.split('.').map((x) => parseInt(x, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

function compareSemVer(vA, vB) {
  const [a1, a2, a3] = parseSemVerTuple(vA);
  const [b1, b2, b3] = parseSemVerTuple(vB);
  if (a1 !== b1) return a1 > b1 ? 1 : -1;
  if (a2 !== b2) return a2 > b2 ? 1 : -1;
  if (a3 !== b3) return a3 > b3 ? 1 : -1;
  return 0;
}

function extractVersionFromHtml(htmlContent) {
  if (!htmlContent || typeof htmlContent !== 'string') return '0.0.0';
  const m = htmlContent.match(/const\s+CURRENT_SCRIPT_VERSION\s*=\s*["']([^"']+)["']/);
  return m && m[1] ? m[1] : '0.0.0';
}

function extractScriptTimestampFromHtml(htmlContent) {
  if (!htmlContent || typeof htmlContent !== 'string') return 0;
  const m = htmlContent.match(/const\s+CURRENT_SCRIPT_TS\s*=\s*(\d+)/);
  return m && m[1] ? Number(m[1]) : 0;
}

function computeSecuritySignature(inputStr) {
  const str = 'MARKENS_SHIELD_SALT_2026::' + String(inputStr);
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'mksig_' + (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

function computeOtaReleaseSignature(version, buildTs) {
  return computeSecuritySignature(`OTA_RELEASE::${version}::${Number(buildTs || 0)}`);
}

function isValidOtaHtmlDocument(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string' || rawHtml.length < 50000) return false;
  if (!rawHtml.includes('<html') || !rawHtml.includes('</html>') || !rawHtml.includes('MARKENS_BUILD_VERSION')) return false;
  if (/<script[^>]+src=/i.test(rawHtml)) return false;
  return true;
}

function isNewerBuild(candVer, candTs, baseVer, baseTs) {
  const cmp = compareSemVer(candVer, baseVer);
  if (cmp > 0) return true;
  if (cmp === 0 && Number(candTs || 0) > Number(baseTs || 0)) return true;
  return false;
}

function getOtaPaths() {
  if (!app || typeof app.getPath !== 'function') return null;
  const userDir = app.getPath('userData');
  return {
    userDir,
    otaPath: path.join(userDir, 'ota_latest_index.html'),
    tmpPath: path.join(userDir, 'ota_latest_index.html.tmp'),
    bakPath: path.join(userDir, 'ota_prev_index.html'),
    metaPath: path.join(userDir, 'ota_meta.json')
  };
}

function readOtaMeta() {
  try {
    const p = getOtaPaths();
    if (!p || !fs.existsSync(p.metaPath)) return null;
    return JSON.parse(fs.readFileSync(p.metaPath, 'utf8'));
  } catch (_e) {
    return null;
  }
}

function writeOtaMeta(metaObj) {
  try {
    const p = getOtaPaths();
    if (!p) return;
    fs.writeFileSync(p.metaPath, JSON.stringify(metaObj, null, 2), 'utf8');
  } catch (_e) {}
}

function rollbackBrokenOta() {
  try {
    const p = getOtaPaths();
    if (!p) return path.join(__dirname, 'index.html');
    if (fs.existsSync(p.otaPath)) {
      try { fs.unlinkSync(p.otaPath); } catch (_e) {}
    }
    if (fs.existsSync(p.bakPath)) {
      const bakHtml = fs.readFileSync(p.bakPath, 'utf8');
      if (isValidOtaHtmlDocument(bakHtml)) {
        fs.copyFileSync(p.bakPath, p.otaPath);
        writeOtaMeta({
          version: extractVersionFromHtml(bakHtml),
          buildTs: extractScriptTimestampFromHtml(bakHtml),
          source: 'rollback',
          verified: true,
          failCount: 0,
          updatedAt: Date.now()
        });
        return p.otaPath;
      }
    }
    writeOtaMeta({ version: APP_BUNDLED_VERSION, buildTs: APP_BUNDLED_TS, source: 'bundled', verified: true, failCount: 0, updatedAt: Date.now() });
  } catch (_err) {}
  return path.join(__dirname, 'index.html');
}

function resolveBestStartupHtmlPath() {
  const bundledPath = path.join(__dirname, 'index.html');
  try {
    const p = getOtaPaths();
    if (!p || !fs.existsSync(p.otaPath)) return bundledPath;
    const bundledHtml = fs.existsSync(bundledPath) ? fs.readFileSync(bundledPath, 'utf8') : '';
    const otaHtml = fs.readFileSync(p.otaPath, 'utf8');
    if (!isValidOtaHtmlDocument(otaHtml)) {
      try { fs.unlinkSync(p.otaPath); } catch (_e) {}
      return bundledPath;
    }
    const meta = readOtaMeta();
    if (meta && meta.verified === false && Number(meta.failCount || 0) >= 2) {
      return rollbackBrokenOta();
    }
    const bundledVer = extractVersionFromHtml(bundledHtml) || APP_BUNDLED_VERSION;
    const bundledTs = extractScriptTimestampFromHtml(bundledHtml) || APP_BUNDLED_TS;
    const otaVer = extractVersionFromHtml(otaHtml);
    const otaTs = extractScriptTimestampFromHtml(otaHtml);
    if (isNewerBuild(otaVer, otaTs, bundledVer, bundledTs)) {
      if (meta && meta.verified === false) {
        writeOtaMeta({ ...meta, failCount: Number(meta.failCount || 0) + 1 });
      }
      return p.otaPath;
    }
    // If bundled .exe is newer or equal, remove stale cached OTA file
    try { fs.unlinkSync(p.otaPath); } catch (_e) {}
  } catch (_err) {}
  return bundledPath;
}

function getCurrentlyActiveBuildInfo() {
  try {
    const activePath = resolveBestStartupHtmlPath();
    if (fs.existsSync(activePath)) {
      const content = fs.readFileSync(activePath, 'utf8');
      const meta = readOtaMeta();
      return {
        path: activePath,
        isOta: activePath !== path.join(__dirname, 'index.html'),
        version: extractVersionFromHtml(content) || APP_BUNDLED_VERSION,
        ts: extractScriptTimestampFromHtml(content) || APP_BUNDLED_TS,
        source: (meta && meta.source) ? meta.source : 'bundled'
      };
    }
  } catch (_e) {}
  return {
    path: path.join(__dirname, 'index.html'),
    isOta: false,
    version: 'v' + APP_BUNDLED_VERSION,
    ts: APP_BUNDLED_TS,
    source: 'bundled'
  };
}

function writeOtaHtmlAtomically(rawHtml, sourceName = 'Firebase') {
  if (!isValidOtaHtmlDocument(rawHtml)) return null;
  const p = getOtaPaths();
  if (!p) return null;
  const curInfo = getCurrentlyActiveBuildInfo();
  const newVer = extractVersionFromHtml(rawHtml);
  const newTs = extractScriptTimestampFromHtml(rawHtml);
  if (!isNewerBuild(newVer, newTs, curInfo.version, curInfo.ts)) {
    return null;
  }
  fs.writeFileSync(p.tmpPath, rawHtml, 'utf8');
  if (fs.existsSync(p.otaPath)) {
    try { fs.copyFileSync(p.otaPath, p.bakPath); } catch (_e) {}
  }
  fs.renameSync(p.tmpPath, p.otaPath);
  writeOtaMeta({
    version: newVer,
    buildTs: newTs,
    source: sourceName,
    verified: false,
    failCount: 0,
    updatedAt: Date.now()
  });
  return { otaPath: p.otaPath, version: newVer, buildTs: newTs, source: sourceName };
}

class MarkensUpdaterService {
  constructor(options = {}) {
    this.currentVersion = options.currentVersion || APP_BUNDLED_VERSION;
    this.autoUpdater = options.autoUpdater || null;
    this.onStatusChange = typeof options.onStatusChange === 'function' ? options.onStatusChange : () => {};
    this.onBeforeQuitAndInstall = typeof options.onBeforeQuitAndInstall === 'function' ? options.onBeforeQuitAndInstall : () => {};
    this.state = {
      status: 'idle',
      version: this.currentVersion,
      availableVersion: null,
      progress: 0,
      error: null
    };
    if (this.autoUpdater) {
      this._bindEvents();
    }
  }

  _emit(patch) {
    this.state = { ...this.state, ...patch };
    this.onStatusChange(this.state);
  }

  _bindEvents() {
    const au = this.autoUpdater;
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;
    au.allowPrerelease = false;

    au.on('checking-for-update', () => {
      this._emit({ status: 'checking', error: null });
    });

    au.on('update-available', (info) => {
      const candidateVer = info && info.version ? String(info.version) : null;
      if (!candidateVer || compareSemVer(candidateVer, this.currentVersion) <= 0) {
        this._emit({ status: 'up-to-date', availableVersion: null, error: null });
        return;
      }
      this._emit({ status: 'available', availableVersion: candidateVer, error: null });
    });

    au.on('update-not-available', () => {
      this._emit({ status: 'up-to-date', availableVersion: null, error: null });
    });

    au.on('download-progress', (prog) => {
      const pct = prog && typeof prog.percent === 'number' ? Math.round(prog.percent) : 0;
      this._emit({ status: 'downloading', progress: pct });
    });

    au.on('update-downloaded', (info) => {
      const dlVer = (info && info.version) || this.state.availableVersion;
      this._emit({ status: 'downloaded', availableVersion: dlVer, progress: 100, error: null });
    });

    au.on('error', (err) => {
      this._emit({ status: 'error', error: err && err.message ? err.message : String(err || 'Unknown error') });
    });
  }

  async checkForUpdates() {
    if (!this.autoUpdater) {
      this._emit({ status: 'up-to-date' });
      return { status: 'up-to-date', version: this.currentVersion };
    }
    try {
      this._emit({ status: 'checking', error: null });
      const res = await this.autoUpdater.checkForUpdates();
      return res;
    } catch (err) {
      this._emit({ status: 'error', error: err && err.message ? err.message : String(err) });
      return null;
    }
  }

  async downloadUpdate() {
    if (!this.autoUpdater || this.state.status !== 'available') {
      return false;
    }
    try {
      this._emit({ status: 'downloading', progress: 0, error: null });
      await this.autoUpdater.downloadUpdate();
      return true;
    } catch (err) {
      this._emit({ status: 'error', error: err && err.message ? err.message : String(err) });
      return false;
    }
  }

  quitAndInstall() {
    if (!this.autoUpdater || this.state.status !== 'downloaded') {
      return false;
    }
    this.onBeforeQuitAndInstall();
    this.autoUpdater.quitAndInstall(false, true);
    return true;
  }
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let gameDetectInterval = null;
let updaterService = null;
let nativeOtaInterval = null;
let binaryUpdaterInterval = null;
let nativeOtaBusy = false;
let activeLoadedFilePath = null;
let activeLoadedBootHealthy = false;

if (app && typeof app.requestSingleInstanceLock === 'function') {
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
}

function getAppIconPath() {
  const icoPath = path.join(__dirname, 'assets', 'icon.ico');
  const pngPath = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(icoPath)) return icoPath;
  if (fs.existsSync(pngPath)) return pngPath;
  return undefined;
}

function syncWindowAndTrayVersionTitle(verStr) {
  const cleanVer = String(verStr || ('v' + APP_BUNDLED_VERSION));
  const formatted = cleanVer.startsWith('v') ? cleanVer : ('v' + cleanVer);
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle('MARKENS ' + formatted);
    }
    if (tray && typeof tray.setToolTip === 'function') {
      tray.setToolTip('MARKENS ' + formatted + ' — Голосовой и игровой мессенджер');
    }
  } catch (_e) {}
}

function loadAppHtmlIntoWindow(targetHtmlPath) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  activeLoadedFilePath = targetHtmlPath;
  activeLoadedBootHealthy = false;
  try {
    if (fs.existsSync(targetHtmlPath)) {
      const ver = extractVersionFromHtml(fs.readFileSync(targetHtmlPath, 'utf8'));
      if (ver && ver !== '0.0.0') syncWindowAndTrayVersionTitle(ver);
    }
  } catch (_e) {}
  mainWindow.loadFile(targetHtmlPath);
}

function createWindow() {
  const initInfo = getCurrentlyActiveBuildInfo();
  const initVer = initInfo.version.startsWith('v') ? initInfo.version : ('v' + initInfo.version);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    title: 'MARKENS ' + initVer,
    backgroundColor: '#16171a',
    icon: getAppIconPath(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });

  session.defaultSession.setPermissionCheckHandler(() => true);

  // Strip Mark-of-the-Web (Zone.Identifier) on completed downloads in Windows so files never show "Подозрительный файл"
  session.defaultSession.on('will-download', (_event, item) => {
    item.once('done', (_ev, state) => {
      if (state === 'completed' && process.platform === 'win32') {
        try {
          const savePath = item.getSavePath();
          if (savePath) {
            try { fs.unlinkSync(savePath + ':Zone.Identifier'); } catch (_e) {}
          }
        } catch (_err) {}
      }
    });
  });

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      if (sources && sources.length > 0) {
        callback({ video: sources[0], audio: 'loopback' });
      } else {
        callback({});
      }
    }).catch(() => callback({}));
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

  // Crash-rollback protection if an unverified OTA HTML fails to load
  const handleBootFailure = () => {
    const p = getOtaPaths();
    if (p && activeLoadedFilePath === p.otaPath && !activeLoadedBootHealthy) {
      const safePath = rollbackBrokenOta();
      if (safePath !== activeLoadedFilePath) {
        loadAppHtmlIntoWindow(safePath);
      }
    }
  };
  mainWindow.webContents.on('did-fail-load', handleBootFailure);
  mainWindow.webContents.on('render-process-gone', handleBootFailure);

  const targetHtmlPath = resolveBestStartupHtmlPath();
  loadAppHtmlIntoWindow(targetHtmlPath);

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
      {
        label: 'Проверить обновления сейчас',
        click: () => {
          checkAndDownloadNativeCloudOta({ manual: true });
          if (updaterService) updaterService.checkForUpdates();
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
    const info = getCurrentlyActiveBuildInfo();
    const vTxt = info.version.startsWith('v') ? info.version : ('v' + info.version);
    tray.setToolTip('MARKENS ' + vTxt + ' — Голосовой и игровой мессенджер');
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
    { exe: 'subnautica.exe', name: 'Subnautica' },
    { exe: 'dota2.exe', name: 'Dota 2' },
    { exe: 'valorant.exe', name: 'Valorant' },
    { exe: 'valorant-win64-shipping.exe', name: 'Valorant' },
    { exe: 'gta5.exe', name: 'Grand Theft Auto V' },
    { exe: 'rustclient.exe', name: 'Rust' },
    { exe: 'r5apex.exe', name: 'Apex Legends' },
    { exe: 'fortniteclient-win64-shipping.exe', name: 'Fortnite' },
    { exe: 'cyberpunk2077.exe', name: 'Cyberpunk 2077' },
    { exe: 'helldivers2.exe', name: 'HELLDIVERS 2' },
    { exe: 'stalker2.exe', name: 'S.T.A.L.K.E.R. 2' },
    { exe: 'bg3.exe', name: "Baldur's Gate 3" },
    { exe: 'bg3_dx11.exe', name: "Baldur's Gate 3" },
    { exe: 'eldenring.exe', name: 'Elden Ring' },
    { exe: 'robloxplayerbeta.exe', name: 'Roblox' },
    { exe: 'genshinimpact.exe', name: 'Genshin Impact' },
    { exe: 'starrail.exe', name: 'Honkai: Star Rail' },
    { exe: 'overwatch.exe', name: 'Overwatch 2' },
    { exe: 'tslgame.exe', name: 'PUBG: BATTLEGROUNDS' },
    { exe: 'escapefromtarkov.exe', name: 'Escape from Tarkov' },
    { exe: 'aces.exe', name: 'War Thunder' },
    { exe: 'hl2.exe', name: "Garry's Mod" },
    { exe: 'gmod.exe', name: "Garry's Mod" },
    { exe: 'terraria.exe', name: 'Terraria' },
    { exe: 'phasmophobia.exe', name: 'Phasmophobia' },
    { exe: 'left4dead2.exe', name: 'Left 4 Dead 2' },
    { exe: 'rocketleague.exe', name: 'Rocket League' },
    { exe: 'league of legends.exe', name: 'League of Legends' },
    { exe: 'worldoftanks.exe', name: 'Мир Танков' },
    { exe: 'minecraft.windows.exe', name: 'Minecraft' },
    { exe: 'javaw.exe', name: 'Minecraft' },
    { exe: 'geometrydash.exe', name: 'Geometry Dash' },
    { exe: 'isaac-ng.exe', name: 'The Binding of Isaac' },
    { exe: 'cultofthelamb.exe', name: 'Cult of the Lamb' }
  ];
  const steamAppIdMap = {
    '730': 'Counter-Strike 2',
    '570': 'Dota 2',
    '1422450': 'Deadlock',
    '2073850': 'THE FINALS',
    '553850': 'HELLDIVERS 2',
    '252490': 'Rust',
    '271590': 'Grand Theft Auto V',
    '1172470': 'Apex Legends',
    '1091500': 'Cyberpunk 2077',
    '1643320': 'S.T.A.L.K.E.R. 2',
    '1086940': "Baldur's Gate 3",
    '1245620': 'Elden Ring',
    '578080': 'PUBG: BATTLEGROUNDS',
    '236390': 'War Thunder',
    '4000': "Garry's Mod",
    '105600': 'Terraria',
    '739630': 'Phasmophobia',
    '550': 'Left 4 Dead 2',
    '252950': 'Rocket League',
    '322170': 'Geometry Dash',
    '250900': 'The Binding of Isaac: Rebirth',
    '1313140': 'Cult of the Lamb'
  };

  gameDetectInterval = setInterval(() => {
    exec('reg query HKCU\\Software\\Valve\\Steam /v RunningAppID', { windowsHide: true }, (regErr, regOut) => {
      let steamDetected = null;
      if (!regErr && regOut) {
        const m = regOut.match(/RunningAppID\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i);
        if (m && m[1]) {
          const appId = String(parseInt(m[1], 16));
          if (appId !== '0') {
            steamDetected = steamAppIdMap[appId] || ('Steam Game #' + appId);
          }
        }
      }
      exec('tasklist /nh', { windowsHide: true }, (err, stdout) => {
        let detected = null;
        if (!err && stdout) {
          const lower = stdout.toLowerCase();
          for (const item of gameMap) {
            if (lower.includes(item.exe)) {
              detected = item.name;
              break;
            }
          }
        }
        const finalGame = detected || steamDetected || null;
        if (finalGame !== lastGame) {
          lastGame = finalGame;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('markens:game-detected', finalGame);
          }
        }
      });
    });
  }, 3500);
}

function httpsGetText(urlStr, timeoutMs = 15000, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, { headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'MARKENS-Desktop/' + APP_BUNDLED_VERSION } }, (res) => {
      if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        res.resume();
        const nextUrl = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, urlStr).toString();
        httpsGetText(nextUrl, timeoutMs, maxRedirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Timeout'));
    });
  });
}

async function httpsGetJson(urlStr, timeoutMs = 15000) {
  const txt = await httpsGetText(urlStr, timeoutMs);
  return JSON.parse(txt);
}

function emitNativeOtaProgress(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('markens:ota-progress', payload);
    }
  } catch (_e) {}
}

async function tryFetchOtaFromFirebase(curInfo) {
  const now = Date.now();
  const [cloudVer, cloudTsRaw] = await Promise.all([
    httpsGetJson(`${FIREBASE_OTA_DB}/ota_update/version.json?t=${now}`, 6000),
    httpsGetJson(`${FIREBASE_OTA_DB}/ota_update/buildTs.json?t=${now}`, 6000).catch(() => 0)
  ]);
  if (!cloudVer || typeof cloudVer !== 'string') return null;
  const cloudTs = Number(cloudTsRaw || 0);
  if (!isNewerBuild(cloudVer, cloudTs, curInfo.version, curInfo.ts)) return null;

  emitNativeOtaProgress({ stage: 'downloading', version: cloudVer, source: 'Firebase', percent: 35 });

  let payload = null;
  try {
    payload = await httpsGetJson(`${FIREBASE_OTA_DB}/ota_update.json?t=${Date.now()}`, 22000);
  } catch (_e) {}

  if (!payload || !isValidOtaHtmlDocument(payload.fullHtml)) {
    emitNativeOtaProgress({ stage: 'downloading', version: cloudVer, source: 'Firebase', percent: 65 });
    payload = await httpsGetJson(`${FIREBASE_OTA_DB}/app_releases_v25/latest.json?t=${Date.now()}`, 25000);
  }

  if (!payload || typeof payload !== 'object' || !isValidOtaHtmlDocument(payload.fullHtml)) return null;
  const relVer = payload.version || cloudVer;
  const relTs = Number(payload.buildTs || cloudTs || 0);
  if (payload.signature && payload.signature !== computeOtaReleaseSignature(relVer, relTs)) {
    return null;
  }

  // Strict Anti-Fake-Version check: HTML's REAL embedded version/ts must actually be newer!
  const realHtmlVer = extractVersionFromHtml(payload.fullHtml);
  const realHtmlTs = extractScriptTimestampFromHtml(payload.fullHtml);
  if (!isNewerBuild(realHtmlVer, realHtmlTs, curInfo.version, curInfo.ts)) {
    return null;
  }

  return {
    fullHtml: payload.fullHtml,
    version: realHtmlVer,
    buildTs: realHtmlTs,
    changelog: payload.changelog || '',
    source: 'Firebase'
  };
}

async function tryFetchOtaFromGithubRaw(curInfo) {
  const pkg = await httpsGetJson(`${GITHUB_RAW_BASE}/package.json?t=${Date.now()}`, 6000);
  if (!pkg || typeof pkg !== 'object' || !pkg.version) return null;
  if (compareSemVer(pkg.version, curInfo.version) <= 0) return null;

  emitNativeOtaProgress({ stage: 'downloading', version: 'v' + pkg.version, source: 'GitHub', percent: 45 });
  const htmlStr = await httpsGetText(`${GITHUB_RAW_BASE}/index.html?t=${Date.now()}`, 25000);
  if (!isValidOtaHtmlDocument(htmlStr)) return null;
  const realVer = extractVersionFromHtml(htmlStr);
  const realTs = extractScriptTimestampFromHtml(htmlStr);
  if (!isNewerBuild(realVer, realTs, curInfo.version, curInfo.ts)) return null;

  return {
    fullHtml: htmlStr,
    version: realVer,
    buildTs: realTs,
    changelog: 'Автообновление с GitHub (' + realVer + ')',
    source: 'GitHub'
  };
}

async function tryFetchOtaFromNetlify(curInfo) {
  const htmlStr = await httpsGetText(`${NETLIFY_LIVE_INDEX}?t=${Date.now()}`, 16000);
  if (!isValidOtaHtmlDocument(htmlStr)) return null;
  const realVer = extractVersionFromHtml(htmlStr);
  const realTs = extractScriptTimestampFromHtml(htmlStr);
  if (!isNewerBuild(realVer, realTs, curInfo.version, curInfo.ts)) return null;

  return {
    fullHtml: htmlStr,
    version: realVer,
    buildTs: realTs,
    changelog: 'Автообновление с Netlify (' + realVer + ')',
    source: 'Netlify'
  };
}

async function checkAndDownloadNativeCloudOta(opts = {}) {
  const manual = Boolean(opts && opts.manual);
  if (nativeOtaBusy || !app || typeof app.getPath !== 'function') {
    return { status: 'busy' };
  }
  nativeOtaBusy = true;
  try {
    const curInfo = getCurrentlyActiveBuildInfo();
    if (manual) {
      emitNativeOtaProgress({ stage: 'checking', version: curInfo.version, source: 'auto', percent: 10 });
    }

    let candidate = null;
    try { candidate = await tryFetchOtaFromFirebase(curInfo); } catch (_e1) {}
    if (!candidate) {
      try { candidate = await tryFetchOtaFromGithubRaw(curInfo); } catch (_e2) {}
    }
    if (!candidate && (manual || opts.includeNetlify)) {
      try { candidate = await tryFetchOtaFromNetlify(curInfo); } catch (_e3) {}
    }

    if (!candidate) {
      if (manual) {
        emitNativeOtaProgress({ stage: 'up-to-date', version: curInfo.version, source: curInfo.source, percent: 100 });
      }
      return { status: 'up-to-date', version: curInfo.version };
    }

    emitNativeOtaProgress({ stage: 'verifying', version: candidate.version, source: candidate.source, percent: 90 });
    const saved = writeOtaHtmlAtomically(candidate.fullHtml, candidate.source);
    if (saved && mainWindow && !mainWindow.isDestroyed()) {
      emitNativeOtaProgress({ stage: 'ready', version: saved.version, source: saved.source, percent: 100 });
      mainWindow.webContents.send('markens:ota-ready', {
        version: saved.version,
        buildTs: saved.buildTs,
        changelog: candidate.changelog || '',
        source: saved.source
      });
      return { status: 'ready', version: saved.version, source: saved.source };
    }
    return { status: 'up-to-date', version: curInfo.version };
  } catch (err) {
    if (manual) {
      emitNativeOtaProgress({ stage: 'error', message: err && err.message ? err.message : 'Network error' });
    }
    return { status: 'error', error: err && err.message ? err.message : String(err) };
  } finally {
    nativeOtaBusy = false;
  }
}

if (ipcMain && typeof ipcMain.on === 'function') {
  ipcMain.on('markens:confirm-ota-healthy', (_event, info) => {
    try {
      activeLoadedBootHealthy = true;
      const meta = readOtaMeta();
      if (meta && meta.verified === false) {
        writeOtaMeta({ ...meta, verified: true, failCount: 0, confirmedAt: Date.now() });
      }
      if (info && info.version) syncWindowAndTrayVersionTitle(info.version);
    } catch (_err) {}
  });

  ipcMain.on('markens:apply-update', (_event, rel) => {
    try {
      if (rel && typeof rel === 'object' && isValidOtaHtmlDocument(rel.fullHtml) && app && typeof app.getPath === 'function') {
        const saved = writeOtaHtmlAtomically(rel.fullHtml, rel.source || 'Firebase');
        if (saved && mainWindow && !mainWindow.isDestroyed()) {
          loadAppHtmlIntoWindow(saved.otaPath);
        }
      }
    } catch (_err) {}
  });

  ipcMain.on('markens:reload-ota', () => {
    try {
      const targetPath = resolveBestStartupHtmlPath();
      if (mainWindow && !mainWindow.isDestroyed()) {
        loadAppHtmlIntoWindow(targetPath);
      }
    } catch (_err) {}
  });

  ipcMain.handle('markens:check-native-ota', async () => {
    return checkAndDownloadNativeCloudOta({ manual: true, includeNetlify: true });
  });

  ipcMain.handle('markens:get-active-build-info', async () => {
    return getCurrentlyActiveBuildInfo();
  });

  ipcMain.on('markens:incoming-call', (_event, payload) => {
    try {
      const caller = (payload && payload.caller) ? String(payload.caller) : 'Собеседник';
      const isVid = payload && payload.type === 'video';
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (!mainWindow.isFocused()) {
          try { mainWindow.flashFrame(true); } catch (_e) {}
        }
      }
      if (Notification && typeof Notification.isSupported === 'function' && Notification.isSupported()) {
        const n = new Notification({
          title: isVid ? `📹 Видеозвонок от @${caller}` : `📞 Входящий звонок от @${caller}`,
          body: 'Нажмите, чтобы открыть MARKENS и ответить',
          icon: getAppIconPath(),
          silent: false
        });
        n.on('click', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
            try { mainWindow.flashFrame(false); } catch (_e) {}
          }
        });
        n.show();
      }
    } catch (_err) {}
  });

  ipcMain.on('markens:clear-call-attention', () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false);
    } catch (_err) {}
  });

  ipcMain.handle('markens:check-for-updates', async () => {
    return updaterService ? updaterService.checkForUpdates() : null;
  });
  ipcMain.handle('markens:download-update', async () => {
    return updaterService ? updaterService.downloadUpdate() : false;
  });
  ipcMain.handle('markens:quit-and-install', () => {
    isQuitting = true;
    return updaterService ? updaterService.quitAndInstall() : false;
  });
}

if (app && typeof app.whenReady === 'function') {
  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.whenReady().then(() => {
    let autoUpdaterInstance = null;
    try {
      autoUpdaterInstance = require('electron-updater').autoUpdater;
    } catch (_e) {}
    updaterService = new MarkensUpdaterService({
      currentVersion: app.getVersion ? app.getVersion() : APP_BUNDLED_VERSION,
      autoUpdater: autoUpdaterInstance,
      onBeforeQuitAndInstall: () => {
        isQuitting = true;
      },
      onStatusChange: (statusObj) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('markens:updater-status', statusObj);
        }
      }
    });
    createWindow();
    setupTray();
    setupGlobalHotkeys();
    startSteamProcessDetector();

    // Engine A: Fast 3-source Live OTA (Firebase -> GitHub -> Netlify) right after boot + every 90s
    setTimeout(() => { checkAndDownloadNativeCloudOta({ manual: false, includeNetlify: true }); }, 1500);
    nativeOtaInterval = setInterval(() => { checkAndDownloadNativeCloudOta({ manual: false }); }, 90000);

    // Engine B: Full .exe binary auto-updater (electron-updater via GitHub Releases)
    if (autoUpdaterInstance) {
      setTimeout(() => { updaterService.checkForUpdates(); }, 8000);
      binaryUpdaterInterval = setInterval(() => { updaterService.checkForUpdates(); }, 1800000);
    }
  });

  app.on('will-quit', () => {
    if (gameDetectInterval) { clearInterval(gameDetectInterval); gameDetectInterval = null; }
    if (nativeOtaInterval) { clearInterval(nativeOtaInterval); nativeOtaInterval = null; }
    if (binaryUpdaterInterval) { clearInterval(binaryUpdaterInterval); binaryUpdaterInterval = null; }
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

module.exports = {
  MarkensUpdaterService,
  parseSemVerTuple,
  compareSemVer,
  extractVersionFromHtml,
  extractScriptTimestampFromHtml,
  computeSecuritySignature,
  computeOtaReleaseSignature,
  isValidOtaHtmlDocument,
  isNewerBuild,
  resolveBestStartupHtmlPath,
  writeOtaHtmlAtomically,
  rollbackBrokenOta
};
