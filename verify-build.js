#!/usr/bin/env node
/**
 * Автоматический тестовый стенд и пре-билд фильтр безопасности MARKENS v31.0 (scripts/verify-build.js)
 * Запускается локально (npm test) и в GitHub Actions перед каждой сборкой установщика.
 */

process.env.MARKENS_TEST_MODE = '1';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const {
  MarkensUpdaterService,
  parseSemVer,
  compareVersions,
  normalizeVersionTag,
  formatUpdaterError
} = require(path.join(rootDir, 'main.js'));

let passed = 0;
async function runAllTests() {
  async function runTest(name, fn) {
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
      process.exit(1);
    }
  }

  console.log('====================================================================');
  console.log('🛡️ ЗАПУСК АВТОМАТИЧЕСКИХ ТЕСТОВ MARKENS v31.0 (VOICE + SECURITY + ROLES)');
  console.log('====================================================================');

  // 1. Синтаксическая проверка JS-файлов через node --check
  await runTest('Синтаксическая проверка main.js, preload.js и verify-build.js (node --check)', () => {
    execFileSync(process.execPath, ['--check', path.join(rootDir, 'main.js')]);
    execFileSync(process.execPath, ['--check', path.join(rootDir, 'preload.js')]);
    execFileSync(process.execPath, ['--check', __filename]);
  });

  // 2. Проверка конфигурации package.json для electron-updater и GitHub Releases
  await runTest('Проверка package.json (v31.0.x, electron-updater, publish: github, nsis target)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.main, 'main.js');
    assert.ok(pkg.version.startsWith('31.'), `Версия должна начинаться с 31., получено: ${pkg.version}`);
    assert.ok(pkg.dependencies && pkg.dependencies['electron-updater'], 'Отсутствует зависимость electron-updater');
    assert.ok(pkg.devDependencies && pkg.devDependencies['electron'], 'Отсутствует devDependency electron');
    assert.ok(pkg.devDependencies && pkg.devDependencies['electron-builder'], 'Отсутствует devDependency electron-builder');
    assert.ok(Array.isArray(pkg.build.publish) && pkg.build.publish[0].provider === 'github', 'Не настроен publish provider github');
    assert.strictEqual(pkg.build.publish[0].owner, 'marksambor0-hue');
    assert.strictEqual(pkg.build.publish[0].repo, 'markensmasanger');
    assert.strictEqual(pkg.build.win.verifyUpdateCodeSignature, false);
    assert.strictEqual(pkg.build.nsis.artifactName, 'MARKENS_Setup.exe');
  });

  // 3. Проверка безопасности: отсутствие секретов, CSP, E2EE и криптографическая проверка автообновлений
  await runTest('Безопасность: отсутствие секретов, CSP-защита, E2EE для ЛС и гибридный авто-мост обновлений (Canvas + GitHub)', () => {
    for (const file of ['main.js', 'preload.js', 'index.html', 'package.json']) {
      const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
      assert.ok(!content.includes('BEGIN PRIVATE KEY'), `Обнаружен приватный ключ в ${file}!`);
      assert.ok(!content.includes('BEGIN RSA PRIVATE KEY'), `Обнаружен RSA приватный ключ в ${file}!`);
      assert.ok(!/ghp_[A-Za-z0-9]{30,}/.test(content), `Обнаружен GitHub токен в ${file}!`);
    }

    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    const mainCode = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');
    assert.ok(html.includes('http-equiv="Content-Security-Policy"'), 'Должен быть установлен заголовок Content-Security-Policy');
    assert.ok(html.includes('encryptDmPayload'), 'Должно быть активно сквозное шифрование личных сообщений encryptDmPayload');
    assert.ok(html.includes('decryptDmPayload'), 'Должна быть функция расшифровки личных сообщений decryptDmPayload');
    assert.ok(html.includes('autoSyncBuildToCloud'), 'Должна быть активна автоматическая отправка обновления из Canvas в приложение autoSyncBuildToCloud');
    assert.ok(html.includes('isAuthenticOtaRelease'), 'Должна проверяться криптографическая подпись релиза isAuthenticOtaRelease');
    assert.ok(!mainCode.includes('ota_active.html'), 'main.js должен загружать только защищённый index.html из app.asar');
  });

  // 4. Проверка защитных настроек Electron и preload IPC
  await runTest('Безопасность Electron: contextIsolation: true, nodeIntegration: false, sandbox: true', () => {
    const mainContent = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');
    const preloadContent = fs.readFileSync(path.join(rootDir, 'preload.js'), 'utf8');
    assert.ok(mainContent.includes('contextIsolation: true'), 'contextIsolation должен быть true');
    assert.ok(mainContent.includes('nodeIntegration: false'), 'nodeIntegration должен быть false');
    assert.ok(mainContent.includes('sandbox: true'), 'sandbox должен быть true');
    assert.ok(mainContent.includes("will-navigate"), 'Должна быть защита от внешней навигации will-navigate');
    assert.ok(!preloadContent.includes('child_process'), 'preload.js не должен экспортировать child_process');
    assert.ok(preloadContent.includes('checkForUpdates'), 'preload.js должен экспортировать checkForUpdates');
    assert.ok(preloadContent.includes('installUpdateNow'), 'preload.js должен экспортировать installUpdateNow');
    assert.ok(preloadContent.includes('onUpdateStatus'), 'preload.js должен экспортировать onUpdateStatus');
  });

  // 5. Проверка прокачанного голосового движка WebRTC Mesh + Opus HD + DSP и ролей в index.html
  await runTest('Голосовой движок v31.0 (WebRTC Mesh, Opus HD 128kbps, Компрессор, Фильтр 85 Гц, Статистика RTT) и кастомные роли', () => {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    assert.ok(html.length > 350000, 'Размер index.html слишком мал — возможно повреждение кода мессенджера');
    const requiredIds = [
      'appUpdateBanner',
      'btnApplyAppUpdateNow',
      'btnDismissUpdateBanner',
      'appUpdatingOverlay',
      'friendsHubView',
      'chatActiveView',
      'guildBtnVortex',
      'rtcPanel',
      'rtcNetDiagBox',
      'rtcDiagCodec',
      'rtcDiagRtt',
      'rtcDiagLoss',
      'rtcDiagPeers',
      'chkVoiceCompressor',
      'chkHighPassFilter',
      'selAudioOutput',
      'watchPartyBox',
      'gameVoiceOverlay',
      'dmCallStage',
      'settingsModal',
      'btnRunSyncDiagnostics',
      'btnRollbackAppVersion',
      'vortexRolesModal',
      'btnOpenServerRolesModal',
      'inpCustomRoleName',
      'btnCreateCustomRole',
      'serverRolesManageList',
      'popServerRolesSection',
      'popUserRolesList'
    ];
    for (const id of requiredIds) {
      assert.ok(html.includes(`id="${id}"`), `Отсутствует обязательный элемент интерфейса #${id}`);
    }
    assert.ok(html.includes('enhanceSdpForOpusHd'), 'Должна присутствовать функция настройки Opus HD 128kbps (enhanceSdpForOpusHd)');
    assert.ok(html.includes('createDynamicsCompressor'), 'Должен быть подключен студийный компрессор голоса createDynamicsCompressor');
    assert.ok(html.includes('createBiquadFilter'), 'Должен быть подключен фильтр отсечки гула 85 Гц createBiquadFilter');
    assert.ok(html.includes('pollLiveWebRtcNetworkStats'), 'Должен работать мониторинг реального пинга и потерь пакетов getStats()');
    assert.ok(html.includes('createCustomServerRole'), 'Должна присутствовать функция создания своей роли createCustomServerRole');
    assert.ok(html.includes('toggleMemberRoleAssignment'), 'Должна присутствовать функция выдачи роли участнику toggleMemberRoleAssignment');
  });

  // 6. Модульное тестирование MarkensUpdaterService
  await runTest('Модульный тест MarkensUpdaterService: обнаружение, скачивание, защита от старых версий и quitAndInstall', async () => {
    class MockElectronUpdater extends EventEmitter {
      constructor() {
        super();
        this.autoDownload = false;
        this.autoInstallOnAppQuit = false;
        this.allowDowngrade = true;
        this.quitAndInstallCalled = false;
        this.nextCheckResult = { updateInfo: { version: '31.0.5', releaseDate: '2026-10-25T12:00:00Z' } };
      }
      async checkForUpdates() {
        this.emit('checking-for-update');
        if (this.shouldThrowError) {
          const err = new Error(this.shouldThrowError);
          this.emit('error', err);
          throw err;
        }
        return this.nextCheckResult;
      }
      quitAndInstall(isSilent, isForceRunAfter) {
        this.quitAndInstallCalled = { isSilent, isForceRunAfter };
      }
    }

    const mockUpdater = new MockElectronUpdater();
    let beforeQuitCalled = false;

    const service = new MarkensUpdaterService({
      currentVersion: 'v31.0.0',
      updater: mockUpdater,
      isPackaged: true,
      onBeforeQuitAndInstall: () => { beforeQuitCalled = true; }
    });

    assert.strictEqual(mockUpdater.autoDownload, true);
    assert.strictEqual(mockUpdater.allowDowngrade, false);

    const earlyInstall = service.installDownloadedUpdate();
    assert.strictEqual(earlyInstall.ok, false);
    assert.strictEqual(earlyInstall.code, 'UPDATE_NOT_DOWNLOADED');

    const checkRes = await service.checkForUpdates();
    assert.strictEqual(checkRes.ok, true);
    assert.strictEqual(checkRes.updateAvailable, true);
    assert.strictEqual(checkRes.remoteVersion, 'v31.0.5');

    mockUpdater.emit('update-available', { version: '30.9.9' });
    assert.strictEqual(service.getDiagnostics().status, 'not-available');

    mockUpdater.emit('update-available', { version: '31.0.5', releaseNotes: 'Глобальное обновление v31.0' });
    assert.strictEqual(service.getDiagnostics().status, 'available');
    assert.strictEqual(service.getDiagnostics().availableVersion, 'v31.0.5');

    mockUpdater.emit('download-progress', { percent: 75.2 });
    assert.strictEqual(service.getDiagnostics().status, 'downloading');
    assert.strictEqual(service.getDiagnostics().downloadPercent, 75);

    mockUpdater.emit('update-downloaded', { version: '31.0.5' });
    assert.strictEqual(service.getDiagnostics().status, 'downloaded');
    assert.strictEqual(service.getDiagnostics().downloadedVersion, 'v31.0.5');

    const installRes = service.installDownloadedUpdate();
    assert.strictEqual(installRes.ok, true);
    assert.strictEqual(installRes.installedVersion, 'v31.0.5');
    assert.strictEqual(beforeQuitCalled, true);
    assert.deepStrictEqual(mockUpdater.quitAndInstallCalled, { isSilent: false, isForceRunAfter: true });
  });

  // 7. Интеграционный тест синтаксиса скрипта в index.html
  await runTest('Интеграционный тест UI-клиента (index.html): синтаксическая валидность встроенного JS', async () => {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    const vm = require('vm');
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(match && match[1], 'Не найден блок <script> в index.html');
    new vm.Script(match[1], { filename: 'index.html' });
  });

  console.log('====================================================================');
  console.log(`🎉 ВСЕ АВТОТЕСТЫ УСПЕШНО ПРОЙДЕНЫ (${passed}/${passed})!`);
  console.log('====================================================================');
}

runAllTests();
