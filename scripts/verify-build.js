'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');

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

test('preload exposed version fallback matches the packaged app version', () => {
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const fallback = preload.match(/let appVersion = ['"]([^'"]+)['"]/);
  assert.ok(fallback, 'preload must define a safe version fallback');
  assert.equal(normalizeVersionTag(fallback[1]), normalizeVersionTag(pkg.version));
});

test('fetchWithTimeout keeps its abort deadline active while a response body is stalled', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function fetchWithTimeout(');
  const end = html.indexOf('\n    let __lastFriendReqTs', start);
  assert.ok(start >= 0 && end > start, 'fetchWithTimeout helper must exist');
  const source = html.slice(start, end);
  let requestSignal = null;
  const context = {
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (_resource, options) => {
      requestSignal = options.signal;
      return {
        ok: true,
        body: {},
        json: () => new Promise((_resolve, reject) => {
          const abortError = new Error('response body aborted');
          abortError.name = 'AbortError';
          if (requestSignal.aborted) {
            reject(abortError);
            return;
          }
          requestSignal.addEventListener('abort', () => reject(abortError), { once: true });
        })
      };
    }
  };
  const fetcher = vm.runInNewContext('(' + source + ')', context);
  const response = await fetcher('/slow-response.json', {}, 15);
  assert.equal(requestSignal.aborted, false, 'the deadline must remain active after response headers arrive');
  await assert.rejects(() => response.json(), error => error && error.name === 'AbortError');
  assert.equal(requestSignal.aborted, true, 'a stalled body read must be aborted by the original deadline');
});

test('fetchWithTimeout clears its abort deadline after a successful response body read', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function fetchWithTimeout(');
  const end = html.indexOf('\n    let __lastFriendReqTs', start);
  assert.ok(start >= 0 && end > start, 'fetchWithTimeout helper must exist');
  const source = html.slice(start, end);
  let requestSignal = null;
  const context = {
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (_resource, options) => {
      requestSignal = options.signal;
      return { ok: true, body: {}, json: async () => ({ received: true }) };
    }
  };
  const fetcher = vm.runInNewContext('(' + source + ')', context);
  const response = await fetcher('/quick-response.json', {}, 15);
  const payload = await response.json();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(payload, { received: true });
  assert.equal(requestSignal.aborted, false, 'a completed body read must clear the pending abort timer');
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


test('inline renderer JavaScript parses before a Windows build is accepted', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/.test(match[1]) && match[2].trim());
  assert.ok(blocks.length > 0, 'index.html must contain an inline app script');
  blocks.forEach((match, index) => {
    new vm.Script(match[2], { filename: 'index.inline.' + index + '.js' });
  });
});

test('chat avatar characters, font-size styles, and profile badges cannot inject markup', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /escapeHtml\(String\(activeChannelTitle\)\.charAt\(0\)\.toUpperCase\(\)\)/);
  assert.match(html, /const chatFontSizePx = Math\.min\(24, Math\.max\(12, Number\(window\.chatFontSizePx\) \|\| 15\)\)/);
  assert.match(html, /font-size:\$\{chatFontSizePx\}px/);
  assert.match(html, /escapeHtml\(String\(currentUser\.badge \|\| "🎯"\)\.slice\(0, 12\)\)/);
});

test('voice-room member names and pinned-message authors are escaped', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const remoteVoiceStart = html.indexOf('Object.values(vData).forEach(v => {');
  const remoteVoiceEnd = html.indexOf('FULL WEBRTC P2P MESH', remoteVoiceStart);
  const remoteVoice = html.slice(remoteVoiceStart, remoteVoiceEnd);
  assert.match(remoteVoice, /typeof v\.user !== "string"/);
  assert.match(remoteVoice, /escapeHtml\(v\.user\.charAt\(0\)\.toUpperCase\(\)\)/);
  assert.match(remoteVoice, /const safeVoiceUser = escapeHtml\(v\.user\)/);
  assert.match(remoteVoice, /data-voluser="\$\{safeVoiceUser\}"/);
  const pinStart = html.indexOf('function renderPinnedPopover');
  const pinEnd = html.indexOf('function ', pinStart + 20);
  assert.match(html.slice(pinStart, pinEnd), /escapeHtml\(String\(m\.sender/);
});

test('custom avatars are type/size limited and Steam links are restricted to Steam Community HTTPS', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /f\.size > 5 \* 1024 \* 1024/);
  assert.match(html, /isSafeAvatarUrl\(r\.result\)/);
  assert.match(html, /parsedSteamUrl\.protocol !== "https:"/);
  assert.match(html, /steamcommunity\.com/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('profile and friend UI escapes account names and validates avatar URLs', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /function isSafeAvatarUrl\(url\)/);
  assert.match(html, /isSafeAvatarUrl\(currentUser\.avatar\)/);
  assert.match(html, /const safeAvatarUrl = escapeHtml\(currentUser\.avatar\.trim\(\)\)/);
  assert.match(html, /isSafeAvatarUrl\(prefs\.avatar\)/);
  assert.match(html, /escapeHtml\(currentUser\.name\)/);
  const sidebar = html.slice(html.indexOf('function ensureSidebarDmRow'), html.indexOf('function refreshAllSidebarDmStatuses'));
  assert.match(sidebar, /querySelectorAll\("\.dm-row\[data-friendname\]"\)/);
  assert.match(sidebar, /escapeHtml\(friendNick\)/);
  const friends = html.slice(html.indexOf('function renderFriendsHub'), html.indexOf('async function sendFriendRequest'));
  assert.match(friends, /escapeHtml\(inviteName\)/);
  assert.match(friends, /escapeHtml\(friendName\)/);
});

test('global feedback cards escape all cloud-sourced text and identifiers', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('function renderGlobalFeedbackList');
  const end = html.indexOf('async function submitGlobalFeedback', start);
  const renderer = html.slice(start, end);
  assert.match(renderer, /escapeHtml\(String\(item\.author/);
  assert.match(renderer, /escapeHtml\(String\(item\.category/);
  assert.match(renderer, /escapeHtml\(String\(item\.text/);
  assert.match(renderer, /escapeHtml\(String\(item\.status/);
  assert.doesNotMatch(renderer, /data-id="\$\{item\.id\}"/);
});

test('remote chat messages escape untrusted HTML and reject unsafe media URLs', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderStart = html.indexOf('function renderChatMessages(msgs)');
  const renderEnd = html.indexOf('\n    function ', renderStart + 20);
  assert.ok(renderStart >= 0 && renderEnd > renderStart, 'renderChatMessages must be present');
  const renderer = html.slice(renderStart, renderEnd);
  assert.match(renderer, /isSafeMediaUrl\(rawMediaUrl\)/);
  assert.match(renderer, /escapeHtml\(rawMediaUrl\)/);
  assert.match(renderer, /escapeHtml\(playableAudioUrl\)/);
  assert.match(renderer, /escapeHtml\(m\.sender\)/);
  assert.match(renderer, /escapeHtml\(m\.replyTo\.sender\.slice/);
  assert.match(renderer, /escapeHtml\(String\(s\)\.slice/);
  assert.doesNotMatch(renderer, /src="\$\{m\.mediaUrl\}"/);
  assert.doesNotMatch(renderer, /src="\$\{m\.audioUrl\}"/);
  const replyFn = html.slice(html.indexOf('function startReplyToMessage'), html.indexOf('function cancelReplyMode'));
  assert.match(replyFn, /escapeHtml\(sender\)/);
  assert.match(replyFn, /escapeHtml\(preview\)/);
});

test('chat message IDs use a collision-resistant random suffix', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /window\.crypto && typeof window\.crypto\.randomUUID === "function"/);
  assert.match(html, /randomUUID\(\)\.replace\(\/-\/g, ""\)/);
  assert.match(html, /randomMessageId\.slice\(0, 24\)/);
});

test('chat delivery retries preserve messages and do not drop rapid sends', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /__lastMsgSentTs/);
  assert.match(html, /deliveryState: "sending"/);
  assert.match(html, /function writeChatMessageToCloud/);
  assert.match(html, /function retryPendingChatMessages/);
  assert.match(html, /response && response\.ok/);
  assert.match(html, /__pendingChatRetryLocks/);
  assert.match(html, /__channelFetchLocks/);
  assert.match(html, /pendingLocal/);
});

test('incoming call validation accepts unique per-attempt IDs only for the correct caller/callee pair', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('function isValidIncomingDmCall');
  const end = html.indexOf('function ', start + 20);
  const validator = html.slice(start, end);
  assert.match(validator, /expectedPairPrefix = \[caller, callee\]\.sort\(\)\.join\("_"\) \+ "_"/);
  assert.match(validator, /callId\.slice\(expectedPairPrefix\.length\)/);
  assert.match(validator, /\^\\d\{10,16\}_\[a-z0-9\]\{8,32\}\$/i);
});

test('ending a direct call closes only its peer and preserves other voice-room peer connections', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function endDmCall');
  const end = html.indexOf('document.getElementById("btnStartDmVoiceCall")', start);
  const ending = html.slice(start, end);
  assert.match(ending, /const pKey = getWebRtcPairKey\(peerName\)/);
  assert.match(ending, /closePeerConnectionForUser\(peerName\)/);
  assert.ok(ending.indexOf('const pKey = getWebRtcPairKey(peerName)') < ending.indexOf('closePeerConnectionForUser(peerName)'));
  assert.doesNotMatch(ending, /closeAllPeerConnections\(\)/);
});

test('voice-room and one-to-one calls never reuse a peer connection from another signaling session', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('function ensureWebRtcPeerConnection');
  const end = html.indexOf('function ', start + 40);
  const setup = html.slice(start, end);
  assert.match(setup, /existingKey/);
  assert.match(setup, /expectedDmKey/);
  assert.match(setup, /existingIsDmSession/);
  assert.match(setup, /existingKey !== expectedDmKey/);
  assert.match(setup, /existingPc\.__markensSetupComplete !== true/);
  assert.match(setup, /pc\.__markensSetupComplete = false/);
  assert.match(setup, /pc\.__markensSetupComplete = true/);
  assert.match(setup, /!isCurrentDmPeer && existingIsDmSession/);
  assert.match(setup, /Refusing to reuse a peer connection from another MARKENS session/);
});

test('each DM call gets a unique per-attempt record ID instead of reusing the pair ID', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function startDmCall');
  const end = html.indexOf('async function acceptIncomingCall', start);
  const caller = html.slice(start, end);
  assert.match(caller, /const callPairKey = \[currentUser\.name\.toLowerCase\(\), friendName\.toLowerCase\(\)\]\.sort\(\)\.join\("_"\)/);
  assert.match(caller, /window\.crypto && typeof window\.crypto\.randomUUID === "function"/);
  assert.match(caller, /const callId = callPairKey \+ "_" \+ Date\.now\(\) \+ "_" \+ callNonce\.slice\(0, 20\)/);
});

test('calls require a live microphone and recover serialized WebRTC signaling', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /track\.readyState === "live"/);
  assert.match(html, /await ensureWebRtcPeerConnection\(friendName, true/);
  assert.match(html, /__webrtcPollsInFlight/);
  assert.match(html, /retryOfferResponse/);
  assert.match(html, /__iceRestartInProgress/);
  assert.match(html, /failedBy: currentUser\.name/);
});

test('microphone streams and WebAudio contexts are released after calls or voice-room leave', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /async function stopLocalMediaCapture\(\)/);
  assert.match(html, /trackSet\.forEach\(track =>/);
  assert.match(html, /track\.stop\(\)/);
  assert.match(html, /await audioContext\.close\(\)/);
  assert.match(html, /async function releaseLocalMediaIfIdle\(\)/);
  assert.match(html, /if \(currentVoiceRoom \|\| dmCallStillNeedsMic\) return false/);
  assert.match(html, /await releaseLocalMediaIfIdle\(\)/);
});

test('microphone DSP context resumes before publishing a processed audio track and falls back to raw capture', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function acquireLocalMediaStream');
  const end = html.indexOf('function getWebRtcPairKey', start);
  const capture = html.slice(start, end);
  assert.match(capture, /await localStudioAudioCtx\.resume\(\)/);
  assert.match(capture, /localStudioAudioCtx\.state !== "running"/);
  assert.match(capture, /processedAudioTracks\.length/);
  assert.match(capture, /localMediaStream = rawStream/);
  assert.match(capture, /using the real microphone track/);
});

test('DM calls cannot show connected before the real remote audio path is ready', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const match = html.match(/function isDmCallMediaReady\(pc\) \{[\s\S]*?\n    \}/);
  assert.ok(match, 'isDmCallMediaReady must exist in the renderer');
  const readiness = vm.runInNewContext('(' + match[0].replace(/^function isDmCallMediaReady\(pc\)\s*/, 'function (pc) ') + ')');
  const ready = {
    connectionState: 'connected',
    __markensRemoteAudioTrack: { kind: 'audio', readyState: 'live', muted: false },
    __markensAudioPlaybackReady: true
  };
  assert.equal(readiness(ready), true);
  assert.equal(readiness({ ...ready, connectionState: 'connecting' }), false);
  assert.equal(readiness({ ...ready, __markensRemoteAudioTrack: null }), false);
  assert.equal(readiness({ ...ready, __markensRemoteAudioTrack: { kind: 'audio', readyState: 'live', muted: true } }), false);
  assert.equal(readiness({ ...ready, __markensRemoteAudioTrack: { kind: 'audio', readyState: 'ended', muted: false } }), false);
  assert.equal(readiness({ ...ready, __markensAudioPlaybackReady: false }), false);
});

test('call acceptance is not treated as a completed call and timeout paths are bounded', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /state: "accepted"/);
  assert.match(html, /state = "connecting"/);
  assert.match(html, /armDmCallConnectWatchdog/);
  assert.match(html, /currentRecord\.state === "accepted"/);
  assert.match(html, /function maybeMarkDmCallConnected\(peerName, pc\)/);
  assert.match(html, /call\.state = "connected"/);
  assert.match(html, /maybeMarkDmCallConnected\(peerName, pc\)/);
  assert.doesNotMatch(html, /activeDmCall\.state\s*=\s*"connected"/);
  assert.doesNotMatch(html, /acceptedCall\.state\s*=\s*"connected"/);
});

test('missed incoming calls release the single-call lock and accepted-call failures expose hangup controls', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /function showDmCallFailureStage\(call, message\)/);
  assert.match(html, /const timedOutUnacceptedIncoming = !activeDmCall\.isCaller && activeDmCall\.state === "calling"/);
  assert.match(html, /if \(timedOutUnacceptedIncoming && activeDmCall && activeDmCall\.callId === callId\)\s*\{\s*activeDmCall = null;\s*\}/);
  assert.match(html, /showDmCallFailureStage\(acceptedCall, "Не удалось получить доступ к микрофону/);
  assert.match(html, /showDmCallFailureStage\(acceptedCall, "Не удалось подготовить аудиосоединение/);
});

test('remote-ended or failed incoming calls hide the ringtone modal and release call state', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function checkIncomingDmCalls');
  const end = html.indexOf('// SERVER VOICE ROOMS', start);
  const poller = html.slice(start, end);
  assert.match(poller, /const wasIncomingRing = !activeDmCall\.isCaller && activeDmCall\.state === "calling"/);
  assert.match(poller, /if \(incomingModal\) incomingModal\.style\.display = "none"/);
  assert.match(poller, /if \(activeDmCall && activeDmCall\.callId === failedCall\.callId\) activeDmCall = null/);
  assert.match(poller, /showDmCallFailureStage\(failedCall, message\)/);
});

test('incoming calls are revalidated before microphone capture and cancelled rings release state', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /const verificationResponse = await fetchWithTimeout/);
  assert.match(html, /const incomingStillValid = isValidIncomingDmCall/);
  assert.match(html, /liveCallRecord\.caller/);
  assert.match(html, /missedIncomingWasStillRinging/);
  assert.match(html, /activeDmCall = null/);
  assert.match(html, /Вызов отменён собеседником/);
});

test('SDP answers are retried after failed Firebase writes', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /pc\.__pendingSdpAnswer/);
  assert.match(html, /answerRetryResponse && answerRetryResponse\.ok/);
  assert.match(html, /Initial WebRTC answer could not be delivered/);
  assert.match(html, /ICE restart offer could not be delivered/);
  assert.match(html, /pc\.__lastSdpPublishTs = Date\.now\(\)/);
});

test('ICE candidate delivery retries idempotently and never silently drops a candidate', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /function queueLocalIceCandidate\(pc, pairKey, peerName, candidate\)/);
  assert.match(html, /function flushLocalIceCandidateQueue\(pc, pairKey, peerName\)/);
  assert.match(html, /__pendingIceCandidates\.delete\(candidateId\)/);
  assert.match(html, /method: "PUT"/);
  const onIceMatch = html.match(/pc\.onicecandidate = \(event\) => \{[\s\S]*?\n      \};/);
  assert.ok(onIceMatch, 'ICE candidate event handler must exist');
  assert.match(onIceMatch[0], /queueLocalIceCandidate\(pc, pairKey, peerName/);
  assert.doesNotMatch(onIceMatch[0], /method: "POST"/);
  assert.match(html, /__icePublishRetryTimer/);
});

test('remote ICE candidates must have a matching authenticated signaling peer name', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /const senderMatches = typeof item\.from === "string" && item\.from\.trim\(\)\.toLowerCase\(\) === peerName\.toLowerCase\(\)/);
  assert.match(html, /if \(!candidateLooksValid \|\| !itemIsFresh \|\| !senderMatches\) continue/);
});

test('outgoing calls are not invited when local SDP offer creation fails', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /Could not create the initial WebRTC offer/);
  assert.match(html, /closePeerConnectionForUser\(peerName\);\s*return null;/);
  assert.match(html, /Initial WebRTC offer is queued for retry/);
});

test('outgoing invites and call state updates are not silently ignored', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /invitePublished/);
  assert.match(html, /patchDmCallRecord/);
  assert.match(html, /activeDmCall\.__missingRecordPolls/);
  assert.match(html, /hasLiveAudioSender/);
  assert.match(html, /busyBy: currentUser\.name/);
});

test('direct-call signaling is isolated by unique call ID', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /__markensSignalingPairKey/);
  assert.match(html, /baseKey \+ "__dm_" \+ callId/);
  assert.match(html, /pc\.__markensSignalingPairKey = pairKey/);
});

test('DM image and video attachments are encrypted before cloud storage and decrypted for rendering', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /cloudPayload\.mediaUrl = encryptDmPayload/);
  assert.match(html, /cloudPayload\.mediaUrlE2ee = true/);
  assert.match(html, /m\.mediaUrlE2ee/);
  assert.match(html, /decryptDmPayload\(storedMediaUrl, activeChannel\)/);
});

test('DM reply previews and voice-note payloads are encrypted before cloud writes', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /cloudPayload\.replyTo\.text = encryptDmPayload/);
  assert.match(html, /cloudPayload\.replyTo\.e2ee = true/);
  assert.match(html, /cloudPayload\.audioUrl = encryptDmPayload/);
  assert.match(html, /cloudPayload\.audioUrlE2ee = true/);
  assert.match(html, /m\.replyTo\.e2ee/);
  assert.match(html, /m\.audioUrlE2ee/);
});

test('DM replies are bound to the original channel and decrypt only for local preview', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /function getPlainChatMessageText/);
  assert.match(html, /window\.__activeReplyChannel = activeChannel/);
  assert.match(html, /window\.__activeReplyChannel === channelKey/);
  assert.match(html, /getPlainChatMessageText\(replyTarget, channelKey, messageIsDm\)/);
  assert.match(html, /window\.__activeReplyChannel = null/);
});

test('DM edits use encrypted cloud patches and failed edits enter the retry queue', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /async function patchEditedChatMessage/);
  assert.match(html, /message\.editPending = true/);
  assert.match(html, /myLast\.editPending = true/);
  assert.match(html, /queuedMessage\.editPending === true/);
  assert.match(html, /message\._localDm = editIsDm/);
  assert.match(html, /myLast\._localDm = editIsDm/);
});

test('voice notes use the reliable queue and keep their original channel during recording', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /const recordingChannel = activeChannel/);
  assert.match(html, /const recordingIsDm = isDmChat/);
  assert.match(html, /sendChatMessage\("Голосовое сообщение", reader\.result, "audio"/);
  assert.match(html, /channelKey: recordingChannel/);
  assert.match(html, /blob\.size > 2 \* 1024 \* 1024/);
  assert.match(html, /voiceRec\.start\(1000\)/);
  assert.match(html, /120000/);
});

test('creator login uses the canonical database path regardless of input casing', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /const accountLogin = isCreatorLogin \? "markens" : cleanLogin/);
  assert.match(html, /accounts\/\$\{encodeURIComponent\(accountLogin\)\}\.json/);
  assert.match(html, /name: accountLogin/);
  assert.match(html, /activateAccountStorage\(accountLogin\)/);
});

test('creator privileges are never inferred from a username alone', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /const isOwn = !!currentUser\.isOwner && currentUser\.name\.toLowerCase\(\) === "markens"/);
  assert.doesNotMatch(html, /currentUser\.isOwner = true/);
  assert.match(html, /isCreatorLogin\s*=\s*cleanLogin\.toLowerCase\(\) === "markens"/);
  assert.match(html, /isOwner: isCreatorLogin/);
});

test('saved local profile is only a login hint and never restores an authenticated session', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('const btnQuickEnt = document.getElementById("btnQuickEnterMarkens")');
  const end = html.indexOf('// NAVIGATION FLOW', start);
  const startup = html.slice(start, end);
  assert.match(startup, /const savedHint = loadSavedSession\(\)/);
  assert.match(startup, /currentUser = \{ name: "Гость", isAuthenticated: false, isOwner: false/);
  assert.match(startup, /authModal\.style\.display = "flex"/);
  assert.doesNotMatch(startup, /currentUser = \{ \.\.\.saved/);
  assert.doesNotMatch(startup, /authModal\.style\.display = "none"/);
});

test('account cache namespaces distinguish Unicode usernames that NFKC would collapse', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const helperStart = html.indexOf('function getAccountScopedStorageKey(baseKey, username) {');
  const helperEnd = html.indexOf("\n    }", helperStart) + 6;
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'account-scoped key helper must exist');
  const helperSource = html.slice(helperStart, helperEnd);
  const getKey = vm.runInNewContext('(' + helperSource + ')', { currentUser: null });
  const keyFor = (username) => getKey('markens_msgs_clean', username);

  assert.equal(keyFor('Alex'), 'markens_msgs_clean::Alex', 'ordinary existing cache keys stay compatible');
  assert.notEqual(keyFor('Alex'), keyFor('Ａlex'), 'fullwidth and ASCII usernames must not share a cache');
  assert.notEqual(keyFor('é'), keyFor(String.fromCharCode(0x65, 0x0301)), 'composed and decomposed usernames must not share a cache');
  assert.notEqual(
    keyFor('A' + String.fromCharCode(0xD800)),
    keyFor('A' + String.fromCharCode(0xD801)),
    'malformed UTF-16 identities must remain distinct'
  );
  assert.equal(keyFor('Мария'), 'markens_msgs_clean::' + encodeURIComponent('Мария'));
});

test('logout closes active call, voice peers, screen share, and microphone resources', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const helperStart = html.indexOf('async function cleanupActiveSessionForLogout() {');
  const helperEnd = html.indexOf("\n    }", helperStart) + 6;
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'logout cleanup helper must exist');
  const helperSource = html.slice(helperStart, helperEnd);
  const events = [];
  const context = {
    activeDmCall: { peer: 'bob' },
    currentUser: { name: 'alice', isAuthenticated: true },
    currentVoiceRoom: { id: 'room_cinema' },
    document: {
      getElementById: (id) => id === 'btnLeaveVoice'
        ? { onclick: async () => { events.push('leave-voice-room'); context.currentVoiceRoom = null; } }
        : null
    },
    endDmCall: async () => { events.push('end-dm-call'); },
    stopRingtone: () => { events.push('stop-ringtone'); },
    countOtherUsersInCinema: () => 0,
    clearCinemaVideoState: () => { events.push('clear-cinema'); },
    closeAllPeerConnections: () => { events.push('close-peer-connections'); },
    stopScreenShare: () => { events.push('stop-screen-share'); },
    stopLocalMediaCapture: async () => { events.push('stop-local-media'); },
    micEchoStream: { getTracks: () => [{ stop: () => events.push('stop-echo-track') }] },
    micEchoAudioCtx: { state: 'running', close: async () => { events.push('close-echo-context'); } },
    micEchoTestActive: true
  };
  const cleanup = vm.runInNewContext('(' + helperSource + ')', context);
  await cleanup();

  assert.deepEqual(events, [
    'end-dm-call',
    'leave-voice-room',
    'close-peer-connections',
    'stop-screen-share',
    'stop-local-media',
    'stop-echo-track',
    'close-echo-context'
  ]);
  assert.equal(context.currentVoiceRoom, null);
  assert.equal(context.micEchoStream, null);
  assert.equal(context.micEchoAudioCtx, null);
  assert.equal(context.micEchoTestActive, false);
});

test('account sync discards a late response after logout instead of writing it to guest storage', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const syncStart = html.indexOf('async function syncAllData() {');
  const syncEnd = html.indexOf("\n    let __isSyncingVoice", syncStart);
  assert.ok(syncStart >= 0 && syncEnd > syncStart, 'account sync function must exist');
  const syncSource = html.slice(syncStart, syncEnd);
  const writes = [];
  const context = {
    document: { visibilityState: 'visible' },
    __isSyncingAllData: false,
    currentUser: { name: 'alice', isAuthenticated: true },
    myFriends: [],
    pendingInvites: [],
    DB_URL: 'https://database.example',
    fetch: async () => ({
      ok: true,
      json: async () => {
        context.currentUser = { name: 'Гость', isAuthenticated: false };
        return { bob: true };
      }
    }),
    fetchWithTimeout: (...args) => context.fetch(...args),
    safeSet: (...args) => writes.push(args),
    getAccountScopedStorageKey: (key, username) => key + '::' + username,
    friendsHubView: { style: { display: 'none' } },
    renderFriendsHub: () => { throw new Error('must not render a stale account'); }
  };
  const sync = vm.runInNewContext('(' + syncSource + ')', context);
  await sync();

  assert.deepEqual(context.myFriends, []);
  assert.deepEqual(context.pendingInvites, []);
  assert.equal(writes.length, 0, 'stale account data must not be persisted under the guest identity');
  assert.equal(context.__isSyncingAllData, false, 'the sync lock must always be released');
});


test('account sync times out stalled network reads and can retry on the next cycle', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const syncStart = html.indexOf('async function syncAllData() {');
  const syncEnd = html.indexOf("\n    let __isSyncingVoice", syncStart);
  assert.ok(syncStart >= 0 && syncEnd > syncStart, 'account sync function must exist');
  const syncSource = html.slice(syncStart, syncEnd);
  let requestCount = 0;
  const context = {
    document: { visibilityState: 'visible' },
    __isSyncingAllData: false,
    currentUser: { name: 'alice', isAuthenticated: true },
    myFriends: [],
    pendingInvites: [],
    DB_URL: 'https://database.example',
    fetchWithTimeout: async () => {
      requestCount += 1;
      if (requestCount === 1) throw new Error('network timeout');
      return { ok: true, json: async () => null };
    },
    safeSet: () => {},
    getAccountScopedStorageKey: (key, username) => key + '::' + username,
    friendsHubView: { style: { display: 'none' } },
    renderFriendsHub: () => {},
    console: { warn: () => {} }
  };
  const sync = vm.runInNewContext('(' + syncSource + ')', context);

  await sync();
  assert.equal(context.__isSyncingAllData, false, 'a timed-out request must release the sync lock');
  await sync();
  assert.equal(requestCount, 3, 'the next sync cycle must retry both account endpoints');
  assert.equal(context.__isSyncingAllData, false, 'a successful retry must also release the sync lock');
});

test('cross-device profile sync ignores stale responses after switching accounts', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const syncStart = html.indexOf('function getCrossDeviceProfileUrl(username)');
  const syncEnd = html.indexOf('// Hook profile/theme/avatar changes', syncStart);
  assert.ok(syncStart >= 0 && syncEnd > syncStart, 'profile sync function must exist');
  const syncSource = html.slice(syncStart, syncEnd);

  const pendingFetches = [];
  const savedUsers = [];
  const bioInput = { value: '' };
  const alice = { name: 'alice', bio: '', avatar: null, badge: '🎯', status: 'В сети', isOwner: false, isAuthenticated: true, game: null };
  const context = {
    document: {
      visibilityState: 'visible',
      activeElement: null,
      getElementById: (id) => id === 'inpProfileBio' ? bioInput : null,
      querySelector: () => null
    },
    currentUser: alice,
    DB_URL: 'https://database.example',
    fetch: (url) => new Promise((resolve) => pendingFetches.push({ url, resolve })),
    fetchWithTimeout: (url, options) => context.fetch(url, options),
    isSafeAvatarUrl: () => false,
    escapeHtml: (value) => String(value),
    safeGet: () => '',
    applyThemeClass: () => {},
    saveSessionPermanently: (user) => savedUsers.push(user.name),
    refreshXpUI: () => {}
  };
  const pull = vm.runInNewContext(
    '(() => {' + syncSource + '; return pullCrossDeviceProfileFromCloud; })()',
    context
  );

  const alicePull = pull();
  assert.equal(pendingFetches.length, 1);
  await pull();
  assert.equal(pendingFetches.length, 1, 'duplicate profile pulls for one session must be coalesced');

  let resolveAliceJson;
  let aliceJsonStarted = false;
  pendingFetches[0].resolve({
    ok: true,
    json: () => {
      aliceJsonStarted = true;
      return new Promise((resolve) => { resolveAliceJson = resolve; });
    }
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(aliceJsonStarted, true, 'the first account response should reach JSON parsing');

  const bob = { name: 'bob', bio: '', avatar: null, badge: '🎯', status: 'В сети', isOwner: false, isAuthenticated: true, game: null };
  context.currentUser = bob;
  const bobPull = pull();
  assert.equal(pendingFetches.length, 2, 'a new account session must not be blocked by the old session lock');
  assert.equal(pendingFetches[0].url, 'https://database.example/user_prefs_v26/alice.json');
  assert.equal(pendingFetches[1].url, 'https://database.example/user_prefs_v26/bob.json');

  pendingFetches[1].resolve({
    ok: true,
    json: async () => ({ bio: 'Bob profile' })
  });
  await bobPull;
  assert.equal(bob.bio, 'Bob profile');
  assert.equal(bioInput.value, 'Bob profile');

  resolveAliceJson({ bio: 'Alice private profile' });
  await alicePull;
  assert.equal(alice.bio, '', 'the old account object must not be modified after its session ends');
  assert.equal(bob.bio, 'Bob profile', 'a late response from Alice must never overwrite Bob\'s profile');
  assert.deepEqual(savedUsers, ['bob'], 'only the currently authenticated account may be persisted');
});


test('cross-device profile sync releases its per-session lock after timeout and retries', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const profileStart = html.indexOf('function getCrossDeviceProfileUrl(username)');
  const profileEnd = html.indexOf('// Hook profile/theme/avatar changes', profileStart);
  assert.ok(profileStart >= 0 && profileEnd > profileStart, 'profile sync functions must exist');
  const profileSource = html.slice(profileStart, profileEnd);
  const user = { name: 'alice', bio: '', avatar: null, badge: '🎯', status: 'В сети', isOwner: false, isAuthenticated: true, game: null };
  let requestCount = 0;
  const context = {
    document: {
      visibilityState: 'visible',
      activeElement: null,
      getElementById: () => null,
      querySelector: () => null
    },
    currentUser: user,
    DB_URL: 'https://database.example',
    fetchWithTimeout: async () => {
      requestCount += 1;
      if (requestCount === 1) throw new Error('network timeout');
      return { ok: true, json: async () => ({ bio: 'Recovered profile' }) };
    },
    isSafeAvatarUrl: () => false,
    escapeHtml: value => String(value),
    safeGet: () => '',
    applyThemeClass: () => {},
    saveSessionPermanently: () => {},
    refreshXpUI: () => {}
  };
  const pull = vm.runInNewContext(
    '(() => {' + profileSource + '; return pullCrossDeviceProfileFromCloud; })()',
    context
  );

  await pull();
  assert.equal(user.bio, '', 'a failed request must not partially apply a profile');
  await pull();
  assert.equal(requestCount, 2, 'a later call must not be blocked by a stale in-flight lock');
  assert.equal(user.bio, 'Recovered profile');
});

test('cross-device profile reads and writes preserve case-sensitive account identity', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const profileStart = html.indexOf('function getCrossDeviceProfileUrl(username)');
  const profileEnd = html.indexOf('// Hook profile/theme/avatar changes', profileStart);
  assert.ok(profileStart >= 0 && profileEnd > profileStart, 'profile URL helper and sync functions must exist');
  const profileSource = html.slice(profileStart, profileEnd);
  const writes = [];
  const reads = [];
  const context = {
    DB_URL: 'https://database.example',
    currentUser: { name: 'Alice', avatar: null, bio: '', status: 'В сети', badge: '🎯', isOwner: false, isAuthenticated: true },
    document: { visibilityState: 'visible', body: { className: '' }, activeElement: null, getElementById: () => null, querySelector: () => null },
    fetch: async (url, options = {}) => {
      if (options.method === 'PUT') { writes.push({ url, body: JSON.parse(options.body) }); return { ok: true }; }
      reads.push(url);
      return { ok: true, json: async () => ({ bio: url.endsWith('/Alice.json') ? 'Uppercase account' : 'Lowercase account' }) };
    },
    fetchWithTimeout: (url, options) => context.fetch(url, options),
    isSafeAvatarUrl: () => false,
    escapeHtml: value => String(value),
    safeGet: () => '',
    applyThemeClass: () => {},
    saveSessionPermanently: () => {},
    refreshXpUI: () => {}
  };
  const api = vm.runInNewContext(
    '(() => {' + profileSource + '; return { pushCrossDeviceProfileToCloud, pullCrossDeviceProfileFromCloud }; })()',
    context
  );

  await api.pushCrossDeviceProfileToCloud();
  context.currentUser = { name: 'alice', avatar: null, bio: '', status: 'В сети', badge: '🎯', isOwner: false, isAuthenticated: true };
  await api.pushCrossDeviceProfileToCloud();
  assert.deepEqual(writes.map(item => item.url), [
    'https://database.example/user_prefs_v26/Alice.json',
    'https://database.example/user_prefs_v26/alice.json'
  ], 'profile writes for differently-cased account names must not collide');

  const upper = { name: 'Alice', avatar: null, bio: '', status: 'В сети', badge: '🎯', isOwner: false, isAuthenticated: true };
  context.currentUser = upper;
  await api.pullCrossDeviceProfileFromCloud();
  const lower = { name: 'alice', avatar: null, bio: '', status: 'В сети', badge: '🎯', isOwner: false, isAuthenticated: true };
  context.currentUser = lower;
  await api.pullCrossDeviceProfileFromCloud();
  assert.deepEqual(reads, [
    'https://database.example/user_prefs_v26/Alice.json',
    'https://database.example/user_prefs_v26/alice.json'
  ], 'profile reads must use the same case-sensitive account identity as authentication');
  assert.equal(upper.bio, 'Uppercase account');
  assert.equal(lower.bio, 'Lowercase account');
});
test('update restore state is account-scoped and waits until authentication', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /getAccountScopedStorageKey\("markens_update_restore_state", currentUser\.name\)/);
  assert.match(html, /if \(!currentUser \|\| !currentUser\.name \|\| currentUser\.isAuthenticated !== true\) return/);
  assert.match(html, /pullCrossDeviceProfileFromCloud\(\);\s*restoreUiStateAfterUpdate\(\);/);
});

test('fresh startup never grants the creator or guest access without a saved non-owner session', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /let currentUser = \{ name: "Гость", isAuthenticated: false, isOwner: false/);
  assert.match(html, /authModal\.style\.display = "flex"/);
  assert.match(html, /Для безопасного входа введите имя пользователя и пароль/);
  assert.doesNotMatch(html, /inpAuthPass\.value = "12345"/);
  assert.match(html, /savedHint\.name\.toLowerCase\(\) !== "markens"/);
});

test('registration rejects invalid Firebase Realtime Database account keys', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('function isValidFirebaseAccountKey(value) {');
  const end = html.indexOf('\n    }', start) + 6;
  assert.ok(start >= 0 && end > start, 'Firebase account-key validator must exist');
  const validate = vm.runInNewContext('(' + html.slice(start, end) + ')');
  for (const character of ['.', '$', '#', '[', ']', '/']) {
    assert.equal(validate('alex' + character + 'test'), false);
  }
  for (const code of [0, 1, 31, 127]) {
    assert.equal(validate('alex' + String.fromCharCode(code) + 'test'), false);
  }
  assert.equal(validate(String.fromCharCode(0xD800)), false);
  assert.equal(validate('a'.repeat(33)), false);
  for (const valid of ['alex', 'Alex', 'Алексей', 'user_name', 'user-name', 'user+tag', '100%']) {
    assert.equal(validate(valid), true);
  }
  const authStart = html.indexOf('async function handleAuth()');
  const authEnd = html.indexOf('btnSubmitAuth.onclick = handleAuth', authStart);
  assert.ok(authStart >= 0 && authEnd > authStart);
  assert.ok(html.slice(authStart, authEnd).includes('if (!isValidFirebaseAccountKey(cleanLogin))'));
});
test('login and registration fail closed when Firebase is unavailable or account state is invalid', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function handleAuth()');
  const end = html.indexOf('btnSubmitAuth.onclick = handleAuth', start);
  const auth = html.slice(start, end);
  assert.match(auth, /Authentication is fail-closed/);
  assert.match(auth, /Не удалось проверить аккаунт/);
  assert.match(auth, /const authMode = isRegMode/);
  assert.match(auth, /if \(authMode\)/);
  assert.match(auth, /Аккаунт не найден\. Переключитесь на регистрацию/);
  assert.match(auth, /Неверный логин или пароль/);
  assert.match(auth, /createAccountIfAbsent\(accountUrl,/);
  assert.match(auth, /createResult\.conflict/);
  assert.doesNotMatch(auth, /Если сеть недоступна, продолжаем локальный вход/);
});

test('Firebase ETag conditional registration allows only one concurrent creator', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const helperMatch = html.match(/async function createAccountIfAbsent\(accountUrl, accountPayload, etag\) \{[\s\S]*?\n    \}/);
  assert.ok(helperMatch, 'conditional account creation helper must exist');

  let storedAccount = null;
  const writes = [];
  const fakeFetch = async (url, options) => {
    writes.push({ url, options });
    if (options.headers['if-match'] !== 'null_etag' || storedAccount !== null) {
      return { ok: false, status: 412 };
    }
    storedAccount = JSON.parse(options.body);
    return { ok: true, status: 200 };
  };
  const create = vm.runInNewContext('(' + helperMatch[0] + ')', { fetchWithTimeout: fakeFetch });
  const [first, second] = await Promise.all([
    create('/accounts/alex.json', { name: 'alex', passwordHash: 'hash-a' }, 'null_etag'),
    create('/accounts/alex.json', { name: 'alex', passwordHash: 'hash-b' }, 'null_etag')
  ]);

  assert.equal([first, second].filter((result) => result.created).length, 1);
  assert.equal([first, second].filter((result) => result.conflict).length, 1);
  assert.equal(writes.length, 2);
  assert.equal(storedAccount.name, 'alex');
  assert.ok(['hash-a', 'hash-b'].includes(storedAccount.passwordHash));
  assert.ok(writes.every((write) => write.options.method === 'PUT'));
  assert.ok(writes.every((write) => write.options.headers['if-match'] === 'null_etag'));
});

test('conditional registration fails closed when Firebase does not expose an ETag', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const helperMatch = html.match(/async function createAccountIfAbsent\(accountUrl, accountPayload, etag\) \{[\s\S]*?\n    \}/);
  assert.ok(helperMatch, 'conditional account creation helper must exist');
  let writes = 0;
  const create = vm.runInNewContext('(' + helperMatch[0] + ')', {
    fetchWithTimeout: async () => { writes += 1; return { ok: true, status: 200 }; }
  });
  await assert.rejects(
    () => create('/accounts/alex.json', { name: 'alex' }, null),
    /Missing Firebase ETag/
  );
  assert.equal(writes, 0, 'no unguarded PUT may occur without an ETag');
});

test('registration captures its selected mode and uses the ETag from the same account read', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function handleAuth()');
  const end = html.indexOf('btnSubmitAuth.onclick = handleAuth', start);
  const auth = html.slice(start, end);
  assert.match(auth, /const authMode = isRegMode/);
  assert.match(auth, /"X-Firebase-ETag": "true"/);
  assert.match(auth, /accountEtag = accRes\.headers\.get\("ETag"\)/);
  assert.match(auth, /createAccountIfAbsent\(accountUrl,[\s\S]*?accountEtag\)/);
  assert.match(auth, /createResult\.conflict/);
  assert.doesNotMatch(auth, /method: "PUT"/);
});

test('VORTEX membership, XP, level, badge, and custom rank are scoped to the exact account identity', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const key of ['markens_xp', 'markens_lvl', 'markens_badge', 'markens_custom_rank', 'vortex_accepted_v25', 'vortex_dismissed_v25']) {
    assert.ok(html.includes('getAccountScopedStorageKey("' + key + '"'), 'Missing account scope for ' + key);
  }
  assert.doesNotMatch(html, /safe(?:Get|Set|Remove)\(["'](?:markens_xp_|markens_lvl_|markens_badge_|markens_custom_rank_|vortex_accepted_v25_|vortex_dismissed_v25_)/);
  assert.match(html, /const isOwn = verifyCreatorPrivilege\(\)/);
  assert.match(html, /if \(verifyCreatorPrivilege\(\)\) return true/);
});

test('chat, friends, and invite caches are namespaced per account and legacy global caches are not imported', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /function getAccountScopedStorageKey\(baseKey, username\)/);
  assert.match(html, /baseKey \+ "::" \+ safeIdentity/);
  assert.match(html, /function activateAccountStorage\(username\)/);
  assert.match(html, /getAccountScopedStorageKey\("markens_msgs_clean"/);
  assert.match(html, /getAccountScopedStorageKey\("markens_friends_clean"/);
  assert.match(html, /getAccountScopedStorageKey\("markens_invites_clean"/);
  assert.doesNotMatch(html, /safeParseStoredJson\("markens_msgs_clean"/);
  assert.doesNotMatch(html, /safeParseStoredJson\("markens_friends_clean"/);
  assert.doesNotMatch(html, /safeParseStoredJson\("markens_invites_clean"/);
});

test('chat cache quota fallback compacts only persisted history and retains unsent edits/messages', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /function saveLocalStore\(\)/);
  assert.match(html, /if \(safeSet\(getAccountScopedStorageKey\("markens_msgs_clean"\), serialized\)\) return true/);
  assert.match(html, /Quota fallback: compact only the persisted snapshot/);
  assert.match(html, /\["sending", "pending"\]\.includes\(m\.deliveryState\) \|\| m\.editPending === true/);
  assert.match(html, /sent\.slice\(-80\)/);
  assert.match(html, /if \(copy\.mediaUrl\) copy\.mediaUrl = ""/);
  assert.match(html, /if \(copy\.audioUrl\) copy\.audioUrl = ""/);
  assert.match(html, /current messages remain available until the app closes/);
});

test('media attachments are size-limited before FileReader loads them into local storage', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function stageMediaFileForChat');
  const end = html.indexOf('function clearStagedMedia', start);
  const stage = html.slice(start, end);
  assert.match(stage, /maxAttachmentBytes = 4 \* 1024 \* 1024/);
  assert.match(stage, /allowedImage/);
  assert.match(stage, /allowedVideo/);
  assert.match(stage, /file\.size > maxAttachmentBytes/);
});

test('late ICE candidates are drained again after the active publisher finishes', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /A candidate can arrive between the empty-queue check and this finally block/);
  assert.match(html, /pc\.__pendingIceCandidates\.size > 0/);
  assert.match(html, /flushLocalIceCandidateQueue\(pc, pairKey, peerName\)\.catch/);
});

test('failed chat edits and sends are retained and retried without unhandled promise rejections', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function retryPendingChatMessages');
  const end = html.indexOf('async function fetchChannelMessages', start);
  const retry = html.slice(start, end);
  assert.match(retry, /m\.editPending === true/);
  assert.match(retry, /patchEditedChatMessage\(key, queuedMessage/);
  assert.match(retry, /writeChatMessageToCloud\(key, queuedMessage/);
  assert.match(retry, /Could not prepare queued message for delivery/);
  assert.match(retry, /__pendingChatRetryLocks\.delete\(key\)/);
});


test('chat history fetch cannot write a previous account response into the next account cache', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function fetchChannelMessages(chKey) {');
  const end = html.indexOf('addWinListener("online"', start);
  assert.ok(start >= 0 && end > start, 'fetchChannelMessages must exist');
  const source = html.slice(start, end).trim();
  const alice = { name: 'alice', isAuthenticated: true };
  const bob = { name: 'bob', isAuthenticated: true };
  const channel = 'dm_alice_bob';
  const aliceStore = { [channel]: [] };
  const bobStore = { [channel]: [] };
  let resolveBody;
  let bodyReadStarted;
  const bodyStarted = new Promise(resolve => { bodyReadStarted = resolve; });
  let saveCalls = 0;
  const context = {
    currentUser: alice,
    localChannelStore: aliceStore,
    __channelFetchLocks: new Set(),
    DB_URL: 'https://database.example',
    retryPendingChatMessages: () => {},
    fetchWithTimeout: async () => ({
      ok: true,
      json: () => {
        bodyReadStarted();
        return new Promise(resolve => { resolveBody = resolve; });
      }
    }),
    activeChannel: channel,
    chatActiveView: { style: { display: 'none' } },
    saveLocalStore: () => { saveCalls += 1; },
    renderChatMessages: () => {},
    console: { warn: () => {} }
  };
  const fetchMessages = vm.runInNewContext('(' + source + ')', context);
  const inFlight = fetchMessages(channel);
  await bodyStarted;

  context.currentUser = bob;
  context.localChannelStore = bobStore;
  resolveBody({ aliceMessage: { sender: 'alice', text: 'private message', ts: 1 } });
  await inFlight;

  assert.deepEqual(bobStore[channel], [], 'Alice history must not be merged into Bob local storage');
  assert.equal(saveCalls, 0, 'a stale response must not persist the next account cache');
  assert.equal(context.__channelFetchLocks.has(channel), false, 'stale fetch must release its channel lock');
});

test('chat history fetch still merges messages for the same authenticated account', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function fetchChannelMessages(chKey) {');
  const end = html.indexOf('addWinListener("online"', start);
  assert.ok(start >= 0 && end > start, 'fetchChannelMessages must exist');
  const source = html.slice(start, end).trim();
  const alice = { name: 'alice', isAuthenticated: true };
  const channel = 'dm_alice_bob';
  const store = { [channel]: [] };
  let saveCalls = 0;
  const context = {
    currentUser: alice,
    localChannelStore: store,
    __channelFetchLocks: new Set(),
    DB_URL: 'https://database.example',
    retryPendingChatMessages: () => {},
    fetchWithTimeout: async () => ({
      ok: true,
      json: async () => ({ aliceMessage: { sender: 'alice', text: 'hello', ts: 1 } })
    }),
    activeChannel: channel,
    chatActiveView: { style: { display: 'none' } },
    saveLocalStore: () => { saveCalls += 1; },
    renderChatMessages: () => {},
    console: { warn: () => {} }
  };
  const fetchMessages = vm.runInNewContext('(' + source + ')', context);
  await fetchMessages(channel);

  assert.equal(store[channel].length, 1, 'current account history should still merge');
  assert.equal(store[channel][0].text, 'hello');
  assert.equal(saveCalls, 1);
  assert.equal(context.__channelFetchLocks.has(channel), false);
});

test('pending message retry cannot update another account cache after an account switch', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function retryPendingChatMessages(channelKey) {');
  const end = html.indexOf('async function fetchChannelMessages', start);
  assert.ok(start >= 0 && end > start, 'retryPendingChatMessages must exist');
  const source = html.slice(start, end).trim();
  const alice = { name: 'alice', isAuthenticated: true };
  const bob = { name: 'bob', isAuthenticated: true };
  const channel = 'dm_alice_bob';
  const aliceStore = { [channel]: [{ id: 'same-id', deliveryState: 'pending', text: 'Alice draft' }] };
  const bobStore = { [channel]: [{ id: 'same-id', deliveryState: 'pending', text: 'Bob draft' }] };
  let resolveWrite;
  let retryStartedResolve;
  const retryStarted = new Promise(resolve => { retryStartedResolve = resolve; });
  let saveCalls = 0;
  let renderCalls = 0;
  const context = {
    currentUser: alice,
    localChannelStore: aliceStore,
    __pendingChatRetryLocks: new Set(),
    writeChatMessageToCloud: () => {
      retryStartedResolve();
      return new Promise(resolve => { resolveWrite = resolve; });
    },
    activeChannel: channel,
    chatActiveView: { style: { display: 'flex' } },
    saveLocalStore: () => { saveCalls += 1; },
    renderChatMessages: () => { renderCalls += 1; },
    console: { warn: () => {} }
  };
  const retryMessages = vm.runInNewContext('(' + source + ')', context);
  const inFlight = retryMessages(channel);
  await retryStarted;

  context.currentUser = bob;
  context.localChannelStore = bobStore;
  resolveWrite(true);
  await inFlight;

  assert.equal(bobStore[channel][0].deliveryState, 'pending', 'Alice retry must not mark Bob message as sent');
  assert.equal(saveCalls, 0, 'stale retry must not persist Bob local cache');
  assert.equal(renderCalls, 0, 'stale retry must not render Bob chat state');
  assert.equal(context.__pendingChatRetryLocks.has(channel), false, 'stale retry must release its lock');
});

test('voice sync never publishes a Guest presence before authentication', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function syncVoiceAndMembers() {');
  const end = html.indexOf('\n    // ======================================', start);
  assert.ok(start >= 0 && end > start, 'voice sync function must exist');
  const source = html.slice(start, end);
  let networkCalls = 0;
  const context = {
    document: { visibilityState: 'visible' },
    currentUser: { name: 'Гость', status: 'Не в сети', isAuthenticated: false },
    __isSyncingVoice: false,
    fetchWithTimeout: async () => { networkCalls += 1; return { ok: true, json: async () => ({}) }; }
  };
  const sync = vm.runInNewContext('(' + source + ')', context);
  await sync();
  assert.equal(networkCalls, 0, 'guest startup must not create or refresh a presence record');
  assert.equal(context.__isSyncingVoice, false, 'guest early return must not acquire the voice sync lock');
});

test('voice sync discards an in-flight response after the authenticated account changes', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function syncVoiceAndMembers() {');
  const end = html.indexOf('\n    // ======================================', start);
  assert.ok(start >= 0 && end > start, 'voice sync function must exist');
  const source = html.slice(start, end);
  const pending = [];
  const alice = { name: 'alice', status: 'В сети', game: null, isAuthenticated: true };
  const context = {
    document: { visibilityState: 'visible' },
    currentUser: alice,
    currentVoiceRoom: null,
    __isSyncingVoice: false,
    DB_URL: 'https://database.example',
    fetchWithTimeout: () => new Promise((resolve) => pending.push(resolve))
  };
  const sync = vm.runInNewContext('(' + source + ')', context);
  const inFlight = sync();
  assert.equal(pending.length, 1, 'authenticated voice sync should begin with a voice-room read');
  context.currentUser = { name: 'bob', status: 'В сети', game: null };
  pending[0]({ ok: true, json: async () => ({}) });
  await inFlight;
  assert.equal(pending.length, 1, 'stale account response must not trigger presence reads or writes');
  assert.equal(context.__isSyncingVoice, false, 'account switch must release the voice sync lock');
});


test('an authenticated account named Guest is not mistaken for guest mode', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const voiceStart = html.indexOf('async function syncVoiceAndMembers() {');
  const voiceEnd = html.indexOf('\n    // ======================================', voiceStart);
  assert.ok(voiceStart >= 0 && voiceEnd > voiceStart, 'voice sync function must exist');
  const voiceSource = html.slice(voiceStart, voiceEnd);
  const pending = [];
  const account = { name: 'Гость', isAuthenticated: true, status: 'В сети', game: null };
  const voiceContext = {
    document: { visibilityState: 'visible' },
    currentUser: account,
    currentVoiceRoom: null,
    __isSyncingVoice: false,
    DB_URL: 'https://database.example',
    fetchWithTimeout: () => new Promise((resolve) => pending.push(resolve))
  };
  const voiceSync = vm.runInNewContext('(' + voiceSource + ')', voiceContext);
  const inFlight = voiceSync();
  assert.equal(pending.length, 1, 'a real account named Guest must still publish/read voice presence');
  voiceContext.currentUser = { name: 'Гость', isAuthenticated: false };
  pending[0]({ ok: false });
  await inFlight;

  const syncStart = html.indexOf('async function syncAllData() {');
  const syncEnd = html.indexOf('\n    let __isSyncingVoice', syncStart);
  assert.ok(syncStart >= 0 && syncEnd > syncStart, 'account sync function must exist');
  const accountSyncSource = html.slice(syncStart, syncEnd);
  let requests = 0;
  const accountContext = {
    document: { visibilityState: 'visible' },
    __isSyncingAllData: false,
    currentUser: account,
    myFriends: [],
    pendingInvites: [],
    DB_URL: 'https://database.example',
    fetchWithTimeout: async () => { requests += 1; return { ok: false }; },
    safeSet: () => {},
    getAccountScopedStorageKey: (key, username) => key + '::' + username,
    friendsHubView: { style: { display: 'none' } },
    renderFriendsHub: () => {},
    console: { warn: () => {} }
  };
  const accountSync = vm.runInNewContext('(' + accountSyncSource + ')', accountContext);
  await accountSync();
  assert.equal(requests, 2, 'a real account named Guest must sync friends and invites');
  assert.equal(accountContext.__isSyncingAllData, false);
});

test('voice sync network failures release the lock so the next heartbeat can retry', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function syncVoiceAndMembers() {');
  const end = html.indexOf('\n    // ======================================', start);
  assert.ok(start >= 0 && end > start, 'voice sync function must exist');
  const source = html.slice(start, end);
  let requests = 0;
  const context = {
    document: { visibilityState: 'visible' },
    currentUser: { name: 'alice', status: 'В сети', game: null, isAuthenticated: true },
    currentVoiceRoom: null,
    __isSyncingVoice: false,
    DB_URL: 'https://database.example',
    isMobileViewport: () => false,
    fetchWithTimeout: async () => {
      requests += 1;
      if (requests === 1) throw new Error('simulated network timeout');
      return { ok: false, json: async () => null };
    }
  };
  const sync = vm.runInNewContext('(' + source + ')', context);
  await sync();
  assert.equal(context.__isSyncingVoice, false, 'failed request must release the lock');
  await sync();
  assert.equal(requests, 5, 'the next heartbeat must retry voice-room, presence, and account reads');
  assert.equal(context.__isSyncingVoice, false, 'retry must also release the lock');
});


test('friend request rejection does not create a phantom local friend or claim success', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function sendFriendRequest() {');
  const end = html.indexOf('document.getElementById("btnSendFriendReq").onclick = sendFriendRequest;', start);
  assert.ok(start >= 0 && end > start, 'sendFriendRequest must exist');
  const source = html.slice(start, end).trim();
  const input = { value: 'bob' };
  const feedback = { style: {}, textContent: '' };
  const friends = [];
  let saves = 0;
  let renders = 0;
  let requests = 0;
  const context = {
    document: { getElementById: id => id === 'inpFriendNick' ? input : feedback },
    currentUser: { name: 'alice', isAuthenticated: true },
    myFriends: friends,
    __lastFriendReqTs: 0,
    DB_URL: 'https://database.example',
    isValidFirebaseAccountKey: () => true,
    fetchWithTimeout: async () => { requests += 1; return { ok: false, status: 403 }; },
    getAccountScopedStorageKey: key => key + '::alice',
    safeSet: () => { saves += 1; },
    renderFriendsHub: () => { renders += 1; }
  };
  const send = vm.runInNewContext('(' + source + ')', context);
  await send();

  assert.equal(requests, 1, 'the rejected request must stop before the friend-list write');
  assert.deepEqual(friends, [], 'a rejected cloud write must not add a local friend');
  assert.equal(saves, 0, 'a rejected cloud write must not persist a phantom friend');
  assert.equal(renders, 0, 'a failed request must not render a success state');
  assert.equal(input.value, 'bob', 'keep the input so the user can retry');
  assert.match(feedback.textContent, /Не удалось отправить запрос/);
  assert.equal(feedback.style.color, 'var(--red)');
});

test('friend request is not cached until both Firebase writes succeed', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function sendFriendRequest() {');
  const end = html.indexOf('document.getElementById("btnSendFriendReq").onclick = sendFriendRequest;', start);
  assert.ok(start >= 0 && end > start, 'sendFriendRequest must exist');
  const source = html.slice(start, end).trim();
  const input = { value: 'bob' };
  const feedback = { style: {}, textContent: '' };
  const friends = [];
  const calls = [];
  let saves = 0;
  const context = {
    document: { getElementById: id => id === 'inpFriendNick' ? input : feedback },
    currentUser: { name: 'alice', isAuthenticated: true },
    myFriends: friends,
    __lastFriendReqTs: 0,
    DB_URL: 'https://database.example',
    isValidFirebaseAccountKey: () => true,
    fetchWithTimeout: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? { ok: true, status: 200 } : { ok: false, status: 500 };
    },
    getAccountScopedStorageKey: key => key + '::alice',
    safeSet: () => { saves += 1; },
    renderFriendsHub: () => {}
  };
  const send = vm.runInNewContext('(' + source + ')', context);
  await send();

  assert.equal(calls.length, 2, 'both cloud writes should be attempted');
  assert.ok(calls[0].url.endsWith("/friend_requests_v24/bob/alice.json"));
  assert.ok(calls[1].url.endsWith("/friends_v22/alice/bob.json"));
  assert.deepEqual(friends, [], 'do not cache a friend if the second cloud write failed');
  assert.equal(saves, 0);
  assert.equal(input.value, 'bob');
  assert.match(feedback.textContent, /не удалось синхронизировать/);
  assert.equal(feedback.style.color, 'var(--red)');
});

test('friend request is added locally only after both Firebase writes succeed', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function sendFriendRequest() {');
  const end = html.indexOf('document.getElementById("btnSendFriendReq").onclick = sendFriendRequest;', start);
  assert.ok(start >= 0 && end > start, 'sendFriendRequest must exist');
  const source = html.slice(start, end).trim();
  const input = { value: 'bob' };
  const feedback = { style: {}, textContent: '' };
  const friends = [];
  const saves = [];
  let renders = 0;
  const calls = [];
  const context = {
    document: { getElementById: id => id === 'inpFriendNick' ? input : feedback },
    currentUser: { name: 'alice', isAuthenticated: true },
    myFriends: friends,
    __lastFriendReqTs: 0,
    DB_URL: 'https://database.example',
    isValidFirebaseAccountKey: () => true,
    fetchWithTimeout: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
    getAccountScopedStorageKey: (key, username) => key + '::' + username,
    safeSet: (key, value) => saves.push({ key, value }),
    renderFriendsHub: () => { renders += 1; }
  };
  const send = vm.runInNewContext('(' + source + ')', context);
  await send();

  assert.equal(calls.length, 2);
  assert.deepEqual(friends, ['bob']);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].key, 'markens_friends_clean::alice');
  assert.equal(JSON.parse(saves[0].value)[0], 'bob');
  assert.equal(input.value, '');
  assert.match(feedback.textContent, /Запрос дружбы отправлен игроку bob/);
  assert.equal(feedback.style.color, 'var(--green)');
  assert.equal(renders, 1);
});

test('friend request finishing after an account switch never writes into the new account cache', async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function sendFriendRequest() {');
  const end = html.indexOf('document.getElementById("btnSendFriendReq").onclick = sendFriendRequest;', start);
  assert.ok(start >= 0 && end > start, 'sendFriendRequest must exist');
  const source = html.slice(start, end).trim();
  const input = { value: 'bob' };
  const feedback = { style: {}, textContent: '' };
  const alice = { name: 'alice', isAuthenticated: true };
  const bob = { name: 'charlie', isAuthenticated: true };
  const bobFriends = [];
  let resolveFirst;
  const calls = [];
  let saves = 0;
  const context = {
    document: { getElementById: id => id === 'inpFriendNick' ? input : feedback },
    currentUser: alice,
    myFriends: [],
    __lastFriendReqTs: 0,
    DB_URL: 'https://database.example',
    isValidFirebaseAccountKey: () => true,
    fetchWithTimeout: (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return new Promise(resolve => { resolveFirst = resolve; });
      return Promise.resolve({ ok: true, status: 200 });
    },
    getAccountScopedStorageKey: (key, username) => key + '::' + username,
    safeSet: () => { saves += 1; },
    renderFriendsHub: () => {}
  };
  const send = vm.runInNewContext('(' + source + ')', context);
  const inFlight = send();
  assert.equal(calls.length, 1, 'the first write should start immediately');

  context.currentUser = bob;
  context.myFriends = bobFriends;
  resolveFirst({ ok: true, status: 200 });
  await inFlight;

  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith("/friend_requests_v24/bob/alice.json"));
  assert.ok(calls[1].url.endsWith("/friends_v22/alice/bob.json"));
  assert.deepEqual(bobFriends, [], 'the new account must not receive the previous account friend');
  assert.equal(saves, 0, 'the new account cache must not be persisted');
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
