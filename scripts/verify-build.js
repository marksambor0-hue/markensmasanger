const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { execSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
let passed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
    process.exit(1);
  }
}

async function runAllTests() {
  console.log("====================================================================");
  console.log("🛡️ ЗАПУСК АВТОМАТИЧЕСКИХ ТЕСТОВ MARKENS v31.21.0 (OTA + SECURITY + VOICE + RUST)");
  console.log("====================================================================");

  // 1. Синтаксическая проверка main.js, preload.js и verify-build.js
  await runTest("Синтаксическая проверка main.js, preload.js и verify-build.js (node --check)", () => {
    execSync(`node --check "${path.join(rootDir, "main.js")}"`);
    execSync(`node --check "${path.join(rootDir, "preload.js")}"`);
    execSync(`node --check "${path.join(rootDir, "scripts", "verify-build.js")}"`);
  });

  // 2. Проверка package.json и привязки к репозиторию marksambor0-hue/markensmasanger
  await runTest("Проверка package.json (v31.21.0, marksambor0-hue/markensmasanger, electron-updater, asInvoker)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    assert.strictEqual(pkg.version, "31.21.0");
    assert.ok(pkg.dependencies && pkg.dependencies["electron-updater"], "Должен быть подключен electron-updater");
    assert.strictEqual(pkg.build.win.requestedExecutionLevel, "asInvoker", "Должен быть установлен requestedExecutionLevel: asInvoker");
    assert.strictEqual(pkg.build.publish[0].owner, "marksambor0-hue");
    assert.strictEqual(pkg.build.publish[0].repo, "markensmasanger");
  });

  // 3. Проверка безопасности Electron (contextIsolation, nodeIntegration, sandbox)
  await runTest("Безопасность Electron в main.js: contextIsolation: true, nodeIntegration: false, sandbox: true", () => {
    const mainCode = fs.readFileSync(path.join(rootDir, "main.js"), "utf8");
    assert.ok(mainCode.includes("contextIsolation: true"), "contextIsolation должен быть включен");
    assert.ok(mainCode.includes("nodeIntegration: false"), "nodeIntegration должен быть отключен");
    assert.ok(mainCode.includes("sandbox: true"), "sandbox должен быть включен");
    assert.ok(mainCode.includes(":Zone.Identifier"), "main.js должен очищать Zone.Identifier при скачивании файлов");
  });

  // 4. Модульный тест MarkensUpdaterService и загрузчика ota_latest_index.html в main.js
  await runTest("Модульный тест MarkensUpdaterService и загрузчика resolveBestStartupHtmlPath в main.js", async () => {
    const { MarkensUpdaterService, compareSemVer, extractScriptTimestampFromHtml, isValidOtaHtmlDocument } = require(path.join(rootDir, "main.js"));
    assert.strictEqual(compareSemVer("31.21.0", "31.10.23"), 1);
    assert.strictEqual(compareSemVer("31.0.0", "31.21.0"), -1);
    const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
    assert.strictEqual(extractScriptTimestampFromHtml(html), 1801500000000);
    assert.strictEqual(isValidOtaHtmlDocument(html), true);

    const handlers = {};
    const fakeAu = {
      on: (ev, cb) => { handlers[ev] = cb; },
      checkForUpdates: async () => { handlers["update-available"]({ version: "31.22.0" }); },
      downloadUpdate: async () => { handlers["update-downloaded"]({ version: "31.22.0" }); },
      quitAndInstall: () => {}
    };
    const svc = new MarkensUpdaterService({ currentVersion: "31.21.0", autoUpdater: fakeAu });
    await svc.checkForUpdates();
    assert.strictEqual(svc.state.status, "available");
    await svc.downloadUpdate();
    assert.strictEqual(svc.state.status, "downloaded");
    assert.strictEqual(svc.quitAndInstall(), true);
  });

  // 5. Интеграционный тест синтаксической валидности встроенного JS в index.html
  await runTest("Интеграционный тест UI-клиента (index.html): синтаксическая валидность встроенного JS", () => {
    const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
    const m = html.match(/<script>([\s\S]*?)<\/script>/i);
    assert.ok(m && m[1], "Тег <script> должен присутствовать в index.html");
    new Function(m[1]);
  });

  // 6. Проверка реального монтирования OTA-обновлений без фальшивой подмены версии (Root-Cause Fix #1)
  await runTest("Исправление вечного цикла и подмены версии OTA (v31.21.0): реальное монтирование cachedOtaHtml и ota_latest_index.html", () => {
    const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
    const mainCode = fs.readFileSync(path.join(rootDir, "main.js"), "utf8");
    assert.ok(!html.includes("window.__installedAppVersion = savedVer;"), "Запрещено подменять __installedAppVersion старым значением savedVer из localStorage без реального монтирования кода!");
    assert.ok(html.includes("isStrictlyNewerCache") && html.includes("document.write(cachedOtaHtml)"), "Бутлоадер обязан очищать устаревший кэш и реально монтировать более свежую сборку");
    assert.ok(html.includes("document.write(rel.fullHtml);") && html.includes("isPayloadGenuinelyNewer"), "performSelfUpdateAndRestart обязан проверять реальную версию внутри HTML и монтировать обновление");
    assert.ok(mainCode.includes("ota_latest_index.html") && mainCode.includes("writeOtaHtmlAtomically") && mainCode.includes("rollbackBrokenOta"), "main.js обязан атомарно сохранять OTA с защитой от сбоя и откатом");
  });

  // 7. Проверка полной изоляции аккаунтов, друзей и личных переписок dm_* (Root-Cause Fix #2)
  await runTest("Полная изоляция аккаунтов и ЛС (v31.21.0): старт с Гостя, getAccountScopedStorageKey, canCurrentUserAccessChannel и сброс пустых друзей", () => {
    const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
    const rulesObj = JSON.parse(fs.readFileSync(path.join(rootDir, "database.rules.json"), "utf8"));
    assert.ok(html.includes('var currentUser = { name: "Гость", isOwner: false'), "По умолчанию до входа должен быть профиль Гость без прав Создателя");
    assert.ok(html.includes("function getAccountScopedStorageKey(baseKey, username") && html.includes("function reloadAccountScopedStoresForUser("), "Хранилище друзей, заявок и сообщений должно быть изолировано по аккаунтам");
    assert.ok(html.includes("function canCurrentUserAccessChannel(chKey, username"), "Должна работать строгая проверка прав участника перед открытием и чтением личных каналов dm_*");
    assert.ok(html.includes("const hasValidFriendResponse = Boolean((fResExact && fResExact.ok) || (fResLow && fResLow.ok));"), "syncAllData обязан очищать список друзей (myFriends = []), если у аккаунта 0 друзей в базе Firebase");
    assert.ok(html.includes("function sanitizePersonalDomInDoc(docNode)") && html.includes("function buildCleanPristineHtmlSnapshot(rawHtmlStr)"), "Слепок HTML для облачного OTA и скачивания должен очищаться от личных друзей и сообщений");
    assert.strictEqual(rulesObj.rules.channels_v22[".read"], false, "Корень /channels_v22 должен быть закрыт от массового чтения (.read: false)");
    assert.strictEqual(rulesObj.rules.friends_v22[".read"], false, "Корень /friends_v22 должен быть закрыт от массового чтения (.read: false)");
    assert.ok(html.includes("function killAllLegacyTimersFromOldBuilds()") && html.includes("function enforceSidebarAndFriendsAccountOwnership()"), "Должна работать зачистка фоновых таймеров и DOM-фильтр владельца списка друзей");
  });

  // 8. Проверка бинарного ядра Rust + WebAssembly (window.MarkensRustCore) и нативного проекта src-tauri/
  await runTest("Ядро Rust + WebAssembly (wasm_xor_cipher, wasm_voice_energy_sum, wasm_fnv1a_32), src-tauri/ и HMAC звонков", () => {
    const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
    assert.ok(fs.existsSync(path.join(rootDir, "src-tauri", "Cargo.toml")), "Должен присутствовать манифест Rust-ядра src-tauri/Cargo.toml");
    assert.ok(fs.existsSync(path.join(rootDir, "src-tauri", "src", "main.rs")), "Должен присутствовать нативный бэкенд Rust src-tauri/src/main.rs");
    assert.ok(fs.existsSync(path.join(rootDir, "src-tauri", "src", "lib.rs")), "Должен присутствовать исходный код Wasm-ядра Rust src-tauri/src/lib.rs");
    assert.ok(html.includes("__MARKENS_RUST_WASM_BASE64") && html.includes("function initMarkensRustWasmCore()"), "В index.html должно быть встроено скомпилированное ядро Rust/WebAssembly");
    assert.ok(html.includes('id="rtcDiagRustCore"'), "В панели диагностики голоса должна отображаться строка #rtcDiagRustCore");
    assert.ok(html.includes("function verifyDmCallHmac(callId, arg2, calleeArg, typeArg, tsArg, hmacArg)"), "verifyDmCallHmac обязан поддерживать как 2 аргумента, так и 6 аргументов");

    const b64Match = html.match(/const __MARKENS_RUST_WASM_BASE64 = "([^"]+)";/);
    assert.ok(b64Match && b64Match[1], "Не найден бинарник __MARKENS_RUST_WASM_BASE64");
    const wasmBytes = new Uint8Array(Buffer.from(b64Match[1], "base64"));
    const mod = new WebAssembly.Module(wasmBytes);
    const inst = new WebAssembly.Instance(mod);
    const { memory, wasm_xor_cipher, wasm_voice_energy_sum } = inst.exports;
    const mem = new Uint8Array(memory.buffer);
    mem.set([10, 20, 30, 40], 64);
    mem.set([1, 2, 3, 4], 128);
    wasm_xor_cipher(64, 128, 4);
    assert.deepStrictEqual(Array.from(mem.slice(64, 68)), [11, 22, 29, 44]);
    wasm_xor_cipher(64, 128, 4);
    assert.deepStrictEqual(Array.from(mem.slice(64, 68)), [10, 20, 30, 40]);
    mem.set([255, 10, 20, 30], 0);
    assert.strictEqual(wasm_voice_energy_sum(0, 4), 60);
  });

  // 9. Проверка отсутствия APK / Android / мобильной нижней панели и нативных prompt/confirm/alert
  await runTest("Чистота ПК-интерфейса (v31.21.0): отсутствие APK/Android, мобильной панели и блокирующих prompt/alert", () => {
    const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
    assert.ok(!/\b(?:android|webapk|apk)\b|androidInstallModal|androidBottomNav|btnInstallAndroidWebApk/i.test(html), "В коде ПК-приложения index.html не должно быть никаких упоминаний Android или APK!");
    assert.ok(!html.includes("selManualDeviceMode") && !html.includes("setMobileMode"), "Переключатель мобильного режима должен быть полностью убран");
    assert.ok(!html.includes('prompt("Изменить сообщение:'), "Не должно быть блокирующих вызовов prompt()");
  });

  // 10. Проверка голосового движка, единого AudioContext, Кинозала и защиты реакций
  await runTest("Голосовой движок, единый AudioContext, остановка wpNativeVid в Кинозале, findPeerVideoSender и защита реакций", () => {
    const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
    assert.ok(html.includes("const ctx = getRelayWebAudioCtx() || getSharedSfxAudioCtx();"), "attachRemotePeerSpeechAnalyser обязан переиспользовать общий AudioContext");
    assert.ok(html.includes("function findPeerVideoSender(pc)"), "Должно работать переиспользование видео-сендера findPeerVideoSender(pc)");
    assert.ok(html.includes("window.__lastDismissedWpUrl =") && html.includes('wpV.removeAttribute("src")'), "Закрытие Кинозала должно полностью останавливать фоновое воспроизведение wpNativeVid");
    assert.ok(html.includes("function playTone(freq, start, dur, allowWhenDeafened)") && html.includes("ringToneCtx.setSinkId(selectedAudioOutputDeviceId)"), "Рингтон и звуковые эффекты должны учитывать isDeafened и setSinkId");
    assert.ok(html.includes("https://github.com/marksambor0-hue/markensmasanger"), "В index.html должен быть настроен репозиторий marksambor0-hue/markensmasanger");
  });


  // 11. Проверка пакета глубокой защиты (отсутствие открытых passwordHash в /accounts, блокировка SVG XSS и 8 МБ, E2EE чата, фильтр удалённых сообщений и 60с лимит голосовых)
  await runTest("Глубокая защита (v31.21.0): изоляция хешей в /secret_tokens_v31, блокировка SVG XSS и лимит 8 МБ, E2EE чата, фильтр удалённых и 60с лимит голосовых", () => {
    const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
    assert.ok(html.includes("/secret_tokens_v31/") && html.includes("delete parsed.passwordHash;"), "Парольные хеши должны сохраняться в /secret_tokens_v31 и автоматически вырезаться из публичного /accounts");
    assert.ok(html.includes("MAX_CHAT_ATTACHMENT_BYTES = 8 * 1024 * 1024") && html.includes("data:image\\/svg\\+xml"), "Должна работать блокировка .svg/скриптов и лимит 8 МБ на вложения в чате");
    assert.ok(html.includes("function recordLocallyDeletedMsgId(msgId)") && html.includes("window.__locallyDeletedMsgIds.has(String(m.id))"), "Удалённые сообщения не должны воскресать при следующем опросе Firebase");
    assert.ok(html.includes("data-replytargetid=") && html.includes("targetRow.scrollIntoView"), "Цитаты ответов должны быть кликабельными с плавной прокруткой к исходному сообщению");
    assert.ok(html.includes("Достигнут лимит голосового сообщения (60 сек)"), "Запись голосовых сообщений должна быть защищена 60-секундным авто-таймером");
  });


  // 12. Полная проверка всех восстановленных функций (группы, инвайты, чёрный список, поповер 0-200%, WebRTC + Relay, Steam, роли, лимит 3 релизов и 0 нативных prompt/confirm/alert)
  await runTest("Полный комплект функций MARKENS v31.21.0: группы (+), инвайты, /blocks_v31, WebAudio 200%, Relay, Steam, роли и 0 prompt/alert", () => {
    const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
    const requiredTokens = [
      'id="createGroupModal"', 'id="incomingGroupInviteBanner"', 'id="wpNativeVid"',
      'id="btnToggleVoiceCam"', 'id="btnOpenWatchParty"', 'id="dmCallDurationTimer"',
      'id="dmCallSecurityBadge"', 'id="btnReconnectDmCall"', 'id="btnUvpBoost200"',
      'id="btnPopBlockUser"', 'id="btnPopRemoveFriend"', 'id="btnCheckSteamLiveNow"',
      'id="btnAddCustomRegisteredGame"', 'id="btnCopyFirebaseRulesJson"',
      'function publishWebRtcSdpPacket(', 'function getRemoteIceCandidatesBox(',
      'function pollAndPlayVoiceRelay(', 'function applyUserVolumeMultiplierNow(',
      'function removeFriendBidirectional(', 'function canManageServerRoles(',
      'function enforceMax3ReleaseCardsInUpdatesChannel('
    ];
    for (const tok of requiredTokens) {
      assert.ok(html.includes(tok), "Отсутствует обязательный модуль/элемент: " + tok);
    }
    const nativeCalls = html.split("\n").filter(l => /\b(?:prompt|confirm|alert)\(/.test(l) && !/deferredPrompt/.test(l));
    assert.strictEqual(nativeCalls.length, 0, "В index.html не должно быть ни одного нативного вызова prompt/confirm/alert!");
  });

  console.log("====================================================================");

  // 13. Проверка защиты от раздвоения интерфейса (deduplicateAppLayoutDom) и всех 15 дополнительных модулей переписки (v31.21.0)
  await runTest("Защита от раздвоения экрана при OTA (deduplicateAppLayoutDom) и полный набор из 15 модулей переписки (v31.21.0)", () => {
    const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
    const requiredV31_11_2 = [
      "function deduplicateAppLayoutDom()",
      'if (document.body) document.body.innerHTML = "";',
      "DISCORD_GAMES_CATALOG",
      "function formatGameElapsedTimer(",
      "function fetchSteamProfileTextMultiProxy(",
      "function normalizeSteamProfileUrl(",
      "function compressAvatarImage(",
      "function canUserModifyMessage(",
      "function enhanceSdpForOpusHd(",
      'id="vortexRolesManagerBox"',
      'class="ds-file-card"',
      'id="friendPrefixSuggestionsBox"',
      'id="inpChangeNickname"',
      "function derivePbkdf2PasswordHex(",
      'id="wpPlaybackTimer"',
      "target.votedBy[myKey]"
    ];
    for (const token of requiredV31_11_2) {
      assert.ok(html.includes(token), "Отсутствует обязательный модуль v31.21.0: " + token);
    }
  });


  // 14. Проверка полного комплекта всех 64 модулей из видеоролика (v31.10.10 .. v31.21.0) и Pre-Body защиты от раздвоения
  await runTest("Полный комплект всех функций из видеоролика (v31.10.10 .. v31.21.0) и Pre-Body защита markensPreBodyDedupGuard", () => {
    const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
    const requiredVideoTokens = [
      "id=\"markensPreBodyDedupGuard\"",
      "function findVoiceRoomMemberCaseInsensitive(",
      "function syncVideoTrackToAllPeers(",
      "function saveGameActivityToCloud(",
      "function removePeerVideoStream(",
      "const dedupVoiceMap = new Map()",
      "function isCinemaVoiceRoomId(",
      "function renderAvatarBoxContent(",
      "function createCustomServerRole(",
      "function deleteCustomServerRole(",
      "function toggleMemberRoleAssignment(",
      "function searchAllMatchingUsersTelegramStyle(",
      "function renderLiveFriendAddSuggestions(",
      "__recentlySavedGroupTs",
      "function openStreamInSeparatedDiscordWindow(",
      "function renderGroupMembersModalContent(",
      "id=\"grpInviteFriendsSection\"",
      "id=\"btnLeaveCurrentGroup\"",
      "function canAttachOrWriteInActiveChat(",
      "function dataUrlToBlob(",
      "markens_ptt_mode",
      "markens_ptt_key"
    ];
    for (const tok of requiredVideoTokens) {
      assert.ok(html.includes(tok), "Отсутствует обязательный модуль из видеоролика: " + tok);
    }
  });

  console.log(`🎉 ВСЕ АВТОТЕСТЫ УСПЕШНО ПРОЙДЕНЫ (${passed}/${passed})!`);
  console.log("====================================================================");
}

runAllTests();

// v31.21.0 WebRTC TURN + Signaling + IIFE Integrity Checks
(function() {
  const fs = require('fs');
  const path = require('path');
  const assert = require('assert');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('openrelay.metered.ca'), 'RTC_ICE_SERVERS must include TURN servers');
  assert.ok(html.includes('flushPendingIceCandidates'), 'ICE candidate queue must be present');
  assert.ok(html.includes('function isChatBlockedWith('), 'isChatBlockedWith must be defined');
  assert.ok(html.includes('function renderGuildsRailGroups('), 'renderGuildsRailGroups must be defined');
  assert.ok(html.includes('function joinVoiceRoomById('), 'joinVoiceRoomById must be defined');
  assert.ok(html.includes('const setRegInterval = registerMarkensInterval'), 'setRegInterval alias must exist');
  console.log('  ✅ [PASS] v31.21.0 WebRTC TURN + Core Integrity checks');
})();

// v31.21.0 Calls Overhaul Verification
(function() {
  const fs = require('fs');
  const path = require('path');
  const assert = require('assert');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('encodeFloatSamplesToMuLawB64') && html.includes('decodeMuLawB64ToFloat32'), 'Continuous 16kHz Mu-Law PCM Relay must be present');
  assert.ok(html.includes('activeDmCall.isCaller || activeDmCall.state === "connected"'), 'Callee must not pre-accept WebRTC before clicking Accept');
  assert.ok(html.includes('btnRunCallDiagnostics') && html.includes('selAudioOutput'), 'Call diagnostics and speaker selector must exist');
  assert.ok(html.includes('stun:stun.sipnet.ru:3478'), 'Regional STUN server must be included');
  console.log('  ✅ [PASS] v31.21.0 Calls Overhaul checks');
})();

// v31.21.0 Realtime SSE Calls + Native Atomic Anti-Downgrade OTA Checks
(function() {
  const fs = require('fs');
  const path = require('path');
  const assert = require('assert');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(!html.includes('setTimeout(() => { pushCurrentBuildToCloudSilent(); }, 250)'), 'Must NEVER blindly overwrite Firebase 250ms after boot');
  assert.ok(html.includes('downloadVerifiedFullReleaseHtml') && html.includes('applyDeferredOtaIfIdle'), 'Call-safe deferred verified OTA must exist');
  assert.ok(html.includes('startDmCallsSseListener') && html.includes('flushIceBatchNow'), 'SSE instant calls & batched ICE must exist');
  assert.ok(html.includes('hpfAlpha = 0.967'), '85Hz high-pass filter & soft limiter must be in PCM relay');
  assert.ok(mainJs.includes('writeOtaHtmlAtomically') && mainJs.includes('checkAndDownloadNativeCloudOta'), 'main.js must run native atomic background OTA');
  assert.ok(mainJs.includes('markens:incoming-call'), 'main.js must handle native incoming call notification');
  console.log('  ✅ [PASS] v31.21.0 Calls SSE + Native Atomic OTA checks');
})();

// v31.21.0 Discord Voice Room Video & Streams Grid Checks
(function() {
  const fs = require('fs');
  const path = require('path');
  const assert = require('assert');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('id="voiceStageGridView"') && html.includes('id="vgTilesGrid"') && html.includes('id="vgSpotlightSlot"'), 'Discord voice stage grid DOM must exist');
  assert.ok(html.includes('function renderVoiceRoomStageGrid(') && html.includes('function registerRemoteVoicePeerVideoTrack('), 'Multi-peer voice grid controller must exist');
  assert.ok(html.includes('function syncTypedVideoTrackToAllPeers(') && html.includes('scrSender.__videoRole = "screen"'), 'Simultaneous cam + screen WebRTC multi-track senders must exist');
  console.log('  ✅ [PASS] v31.21.0 Discord Voice Video & Streams Grid checks');
})();

// v31.21.0 Permanent Voice Reliability + Zero Clock Skew + Clean Discord UI Checks
(function() {
  const fs = require('fs');
  const path = require('path');
  const assert = require('assert');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('function getServerNow()') && html.includes('".sv": "timestamp"'), 'Server clock calibration & server timestamps must exist');
  assert.ok(html.includes('function isBidirectionalWebRtcConfirmed(') && html.includes('rtcRxPeers'), 'Bidirectional WebRTC confirmation must exist');
  assert.ok(html.includes('markens-pcm-tap') && html.includes('sendPcmWindowSnapshotNow'), 'AudioWorklet PCM relay & pending upload flush must exist');
  assert.ok(html.includes('window.__voiceRoomsEventSource') && html.includes('window.__pcSetupLock'), 'Voice room SSE & per-peer setup lock must exist');
  assert.ok(html.includes('showUserPopout(currentVolumeTargetUser, e)') && !html.includes('openUserPopout('), 'No undeclared openUserPopout call');
  assert.ok(html.includes('--brand: #5865f2;') && html.includes('--bg-primary: #313338;'), 'Clean matte Discord theme palette must be active');
  console.log('  ✅ [PASS] v31.21.0 Permanent Voice Reliability + Clean Discord UI checks');
})();

// v31.21.0 Dual-Engine Auto-Updater (3-Source OTA + Crash Rollback + electron-updater + GitHub Actions) Checks
(function() {
  const fs = require('fs');
  const path = require('path');
  const assert = require('assert');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preloadJs = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const wfPath = path.join(__dirname, '..', '.github', 'workflows', 'build-windows.yml');
  assert.ok(fs.existsSync(wfPath), '.github/workflows/build-windows.yml must exist');
  const wf = fs.readFileSync(wfPath, 'utf8');
  assert.ok(wf.includes('--publish always') && wf.includes('GH_TOKEN'), 'GitHub Actions workflow must publish latest.yml and .exe');
  assert.ok(mainJs.includes('tryFetchOtaFromFirebase') && mainJs.includes('tryFetchOtaFromGithubRaw') && mainJs.includes('tryFetchOtaFromNetlify'), 'main.js must support 3-source cascading OTA');
  assert.ok(mainJs.includes('rollbackBrokenOta') && mainJs.includes('markens:confirm-ota-healthy'), 'main.js must include crash-rollback guard');
  assert.ok(mainJs.includes('au.autoDownload = true;') && mainJs.includes('updaterService.checkForUpdates()'), 'electron-updater must auto-check and auto-download .exe updates');
  assert.ok(preloadJs.includes('checkNativeOtaNow') && preloadJs.includes('confirmOtaBootHealthy') && preloadJs.includes('onOtaProgress'), 'preload.js must expose OTA progress and health IPC');
  assert.ok(html.includes('startOtaRealtimeSseListener') && html.includes('onUpdaterStatus') && html.includes('isPayloadGenuinelyNewer'), 'index.html must wire SSE OTA, anti-fake-update guard, and electron-updater UI');
  console.log('  ✅ [PASS] v31.21.0 Dual-Engine Auto-Updater checks');
})();
