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
  formatUpdaterError
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
