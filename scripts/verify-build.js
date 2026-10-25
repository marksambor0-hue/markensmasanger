'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const root = path.resolve(__dirname, '..');
process.env.MARKENS_TEST_MODE = '1';

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const {
  MarkensUpdaterService,
  parseSemVer,
  compareVersions,
  normalizeVersionTag,
  formatUpdaterError,
  isTrustedAppUrl,
  isAllowedPermissionRequest,
  isAllowedPermissionCheck
} = require(path.join(root, 'main.js'));

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test('required Electron project files exist', () => {
  for (const relativePath of ['package.json', 'main.js', 'preload.js', 'index.html', 'icon.ico']) {
    const absolutePath = path.join(root, relativePath);
    assert.ok(fs.existsSync(absolutePath), 'Missing required file: ' + relativePath);
    assert.ok(fs.statSync(absolutePath).size > 0, 'Empty required file: ' + relativePath);
  }
});

test('electron-updater dependency is declared', () => {
  assert.ok(pkg.dependencies && pkg.dependencies['electron-updater'], 'electron-updater must be in dependencies');
});

test('GitHub publishing points to the MARKENS repository', () => {
  const publish = Array.isArray(pkg.build && pkg.build.publish) ? pkg.build.publish[0] : null;
  assert.equal(publish && publish.provider, 'github');
  assert.equal(publish && publish.owner, 'marksambor0-hue');
  assert.equal(publish && publish.repo, 'markensmasanger');
  assert.equal(pkg.build && pkg.build.nsis && pkg.build.nsis.artifactName, 'MARKENS_Setup.exe');
});

test('cloud OTA rewrites CURRENT_SCRIPT_TS and keeps app/release versions in sync', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const tsPattern = /const\s+CURRENT_SCRIPT_TS\s*=\s*\d+\s*;/;
  const versionMatch = html.match(/const\s+CURRENT_SCRIPT_VERSION\s*=\s*["']v?([^"']+)["']\s*;/);
  assert.ok(tsPattern.test(html), 'OTA updater must declare CURRENT_SCRIPT_TS as a numeric timestamp');
  assert.ok(versionMatch, 'index.html must declare CURRENT_SCRIPT_VERSION');
  assert.equal(
    normalizeVersionTag(versionMatch[1]),
    normalizeVersionTag(pkg.version),
    'HTML app version and package.json release version must match'
  );
  const updated = 'const CURRENT_SCRIPT_TS = 123;'.replace(
    tsPattern,
    'const CURRENT_SCRIPT_TS = 456;'
  );
  assert.equal(updated, 'const CURRENT_SCRIPT_TS = 456;');
});

test('Electron permissions require the exact local app entry page', () => {
  const { pathToFileURL } = require('node:url');
  const appUrl = pathToFileURL(path.join(root, 'index.html')).href;
  const otherFileUrl = pathToFileURL(path.join(root, 'other.html')).href;
  const trustedContents = { getURL: () => appUrl };
  const untrustedContents = { getURL: () => 'https://example.invalid/' };

  assert.equal(isTrustedAppUrl(appUrl), true);
  assert.equal(isTrustedAppUrl(otherFileUrl), false);
  assert.equal(isTrustedAppUrl('about:blank'), false);
  assert.equal(isTrustedAppUrl('https://example.invalid/'), false);
  assert.equal(isAllowedPermissionRequest(trustedContents, 'media', appUrl), true);
  assert.equal(isAllowedPermissionRequest(trustedContents, 'media', 'https://example.invalid/'), false);
  assert.equal(isAllowedPermissionRequest(trustedContents, 'clipboard-read', appUrl), false);
  assert.equal(isAllowedPermissionRequest(untrustedContents, 'media', appUrl), false);
  assert.equal(isAllowedPermissionRequest(null, 'media', appUrl), false);
  assert.equal(isAllowedPermissionCheck(trustedContents, 'media', 'file://', { requestingUrl: appUrl, isMainFrame: true }), true);
  assert.equal(isAllowedPermissionCheck(trustedContents, 'media', 'https://example.invalid', { requestingUrl: 'https://example.invalid/', isMainFrame: false }), false);
  assert.equal(isAllowedPermissionCheck(trustedContents, 'media', 'file://', { requestingUrl: otherFileUrl, isMainFrame: true }), false);
  assert.equal(isAllowedPermissionCheck(null, 'notifications', 'file://', {}), false);
});

test('call/signaling guards are present and screen capture requires a user-selected source', () => {
  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(mainSource, /request\.userGesture !== true/);
  assert.match(mainSource, /dialog\.showMessageBox\(mainWindow/);
  assert.match(mainSource, /callback\(null\)/);
  assert.match(html, /isValidIncomingDmCall\(call, cId, currentUser\.name, now\)/);
  assert.match(html, /isValidPeerSdpMessage\(sigData\.sdp, peerName, currentUser\.name\)/);
  assert.match(html, /itemIsFresh/);
  assert.match(html, /senderMatches/);
});

test('download at 100 percent cannot remain stuck forever', async () => {
  class FakeUpdater extends EventEmitter {
    async checkForUpdates() {
      return { updateInfo: { version: '31.0.2' } };
    }
    quitAndInstall() {}
  }
  const fake = new FakeUpdater();
  const service = new MarkensUpdaterService({
    currentVersion: '31.0.1',
    updater: fake,
    isPackaged: true,
    downloadFinalizeTimeoutMs: 15
  });
  const seen = [];
  service.on('status', (status) => seen.push(status.event));

  fake.emit('update-available', { version: '31.0.2', releaseNotes: 'Test' });
  fake.emit('download-progress', { percent: 100 });
  await new Promise((resolve) => setTimeout(resolve, 45));

  assert.equal(service.state.status, 'error');
  assert.match(service.state.lastError, /100%/);
  assert.ok(seen.includes('error'));
});

test('downloaded updater state is recoverable after renderer listener attaches late', () => {
  class FakeUpdater extends EventEmitter {
    async checkForUpdates() { return { updateInfo: { version: '31.0.2' } }; }
    quitAndInstall() {}
  }
  const service = new MarkensUpdaterService({
    currentVersion: '31.0.1',
    updater: new FakeUpdater(),
    isPackaged: true
  });
  service.updater.emit('update-available', { version: '31.0.2', releaseNotes: 'Verified test release' });
  service.updater.emit('update-downloaded', { version: '31.0.2' });
  const diag = service.getDiagnostics();
  assert.equal(diag.status, 'downloaded');
  assert.equal(diag.downloadedVersion, 'v31.0.2');
  assert.equal(diag.releaseNotes, 'Verified test release');
});

test('startup layout guard and updater-state recovery are present', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /querySelectorAll\("\.app-layout"\)/);
  assert.match(html, /appLayoutsAtBoot\[i\]\.remove\(\)/);
  assert.match(html, /diag\.status === "downloaded" && diag\.downloadedVersion/);
  assert.match(html, /diag\.status === "downloading" && diag\.availableVersion/);
});

test('semantic version parser accepts the app version format', () => {
  assert.deepEqual(parseSemVer('v30.1.18'), [30, 1, 18]);
  assert.deepEqual(parseSemVer('30.1'), [30, 1, 0]);
  assert.equal(parseSemVer('not-a-version'), null);
});

test('version comparison and release tag normalization are correct', () => {
  assert.ok(compareVersions('v30.1.18', 'v30.1.0') > 0);
  assert.equal(compareVersions('30.1.0', '30.1.0'), 0);
  assert.ok(compareVersions('30.1.0', '30.2.0') < 0);
  assert.equal(normalizeVersionTag('30.1.18'), 'v30.1.18');
  assert.equal(normalizeVersionTag('latest'), null);
});

test('common updater errors are translated into readable Russian messages', () => {
  assert.match(formatUpdaterError(new Error('Cannot find latest.yml (404)')), /latest\.yml/);
  assert.match(formatUpdaterError(new Error('sha512 checksum mismatch')), /SHA-512/);
  assert.match(formatUpdaterError(new Error('ENOTFOUND github.com')), /интернет|GitHub/);
});

test('updater waits for a downloaded newer version before installing', async () => {
  class FakeUpdater extends EventEmitter {
    async checkForUpdates() {
      this.emit('checking-for-update');
      this.emit('update-available', { version: '30.1.18', releaseNotes: 'Test release' });
      return { updateInfo: { version: '30.1.18' } };
    }
    quitAndInstall(...args) {
      this.installArgs = args;
    }
  }

  const fake = new FakeUpdater();
  const service = new MarkensUpdaterService({
    currentVersion: '30.1.0',
    updater: fake,
    isPackaged: true
  });

  const beforeDownload = service.installDownloadedUpdate();
  assert.equal(beforeDownload.ok, false);
  assert.equal(beforeDownload.code, 'UPDATE_NOT_DOWNLOADED');

  const check = await service.checkForUpdates();
  assert.equal(check.ok, true);
  assert.equal(check.updateAvailable, true);
  assert.equal(service.state.status, 'available');

  fake.emit('update-downloaded', { version: '30.1.18' });
  assert.equal(service.state.status, 'downloaded');

  const installed = service.installDownloadedUpdate();
  assert.equal(installed.ok, true);
  assert.equal(installed.installedVersion, 'v30.1.18');
  assert.deepEqual(fake.installArgs, [false, true]);
});

(async () => {
  let failures = 0;
  for (const item of tests) {
    try {
      await item.run();
      console.log('PASS ' + item.name);
    } catch (error) {
      failures += 1;
      console.error('FAIL ' + item.name);
      console.error(error && error.stack ? error.stack : String(error));
    }
  }

  console.log('\n' + (tests.length - failures) + '/' + tests.length + ' checks passed.');
  if (failures > 0) process.exitCode = 1;
})();
