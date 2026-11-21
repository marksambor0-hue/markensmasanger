# MARKENS Messenger v31.21.0 (Windows 10/11 x64 + Dual-Engine Auto-Updater)

## Система автообновлений без переустановки (v31.21.0, `CURRENT_SCRIPT_TS = 1801500000000`)
1. **Мгновенный 3-канальный OTA (обновление за 2–4 секунды без переустановки .exe)**:
   - **Канал 1 (Firebase RTDB + Realtime SSE):** открытые клиенты узнают о новом релизе менее чем за 1 секунду, проверяют криптоподпись и *реальную* встроенную версию HTML (`isPayloadGenuinelyNewer`), атомарно сохраняют `userData/ota_latest_index.html` и плавно перезагружают окно с сохранением открытого чата.
   - **Канал 2 (GitHub `main`):** даже если просто обновить `index.html` и `package.json` в репозитории `marksambor0-hue/markensmasanger`, установленные `.exe` сами подтянут свежую версию.
   - **Канал 3 (Netlify):** резервная автосинхронизация с `https://markensmesenger.netlify.app/index.html`.
   - **Защита от сбоя (Crash Rollback):** `ota_meta.json` + `ota_prev_index.html` + подтверждение `confirmOtaBootHealthy` гарантируют автоматический откат, если загрузка пойдёт не так.
   - **Бережность к звонкам:** во время звонка или войса обновление никогда не разрывает связь, а ждёт его окончания.
2. **Полное автообновление `.exe` (`electron-updater` + GitHub Actions)**:
   - Включён `autoDownload = true` и `autoInstallOnAppQuit = true`, а также живая зелёная плашка прогресса и кнопка «Перезапустить и установить».
   - Добавлен `.github/workflows/build-windows.yml`, который при пуше собирает `MARKENS_Setup.exe`, `MARKENS_Portable.exe` и `latest.yml` прямо в GitHub Releases.
