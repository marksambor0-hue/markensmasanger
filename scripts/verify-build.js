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

test('creator privileges are never inferred from a username alone', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /const isOwn = !!currentUser\.isOwner && currentUser\.name\.toLowerCase\(\) === "markens"/);
  assert.doesNotMatch(html, /currentUser\.isOwner = true/);
  assert.match(html, /isCreatorLogin\s*=\s*cleanLogin\.toLowerCase\(\) === "markens"/);
  assert.match(html, /isOwner: isCreatorLogin/);
});

test('fresh startup never grants the creator or guest access without a saved non-owner session', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /let currentUser = \{ name: "Гость", isOwner: false/);
  assert.match(html, /authModal\.style\.display = "flex"/);
  assert.match(html, /Для безопасного входа введите имя пользователя и пароль/);
  assert.doesNotMatch(html, /inpAuthPass\.value = "12345"/);
  assert.match(html, /saved\.name\.toLowerCase\(\) !== "markens"/);
});

test('login and registration fail closed when Firebase is unavailable or account state is invalid', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('async function handleAuth()');
  const end = html.indexOf('btnSubmitAuth.onclick = handleAuth', start);
  const auth = html.slice(start, end);
  assert.match(auth, /Authentication is fail-closed/);
  assert.match(auth, /Не удалось проверить аккаунт/);
  assert.match(auth, /if \(isRegMode\)/);
  assert.match(auth, /Аккаунт не найден\. Переключитесь на регистрацию/);
  assert.match(auth, /Неверный логин или пароль/);
  assert.match(auth, /if \(!createRes \|\| !createRes\.ok\)/);
  assert.doesNotMatch(auth, /Если сеть недоступна, продолжаем локальный вход/);
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
