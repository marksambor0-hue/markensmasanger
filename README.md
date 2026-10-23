# MARKENS Messenger v30.1 — Windows build via GitHub Actions

This archive contains the Electron project and the GitHub Actions workflow needed to build Windows x64 executables in GitHub's hosted Windows environment. It does **not** contain a prebuilt `.exe`.

## What's included

- `index.html` — MARKENS interface/application code supplied in the archive
- `main.js`, `preload.js` — Electron main process and preload bridge
- `package.json` — Electron Builder configuration
- `assets/icon.ico`, `assets/icon.png` — app icons in the paths expected by the build config
- `.github/workflows/build-windows.yml` — Windows build workflow

## Build through GitHub (no Node.js needed on your own device)

1. Open https://github.com/new and create a repository under **your own GitHub account**. Call it `MARKENS-Windows` or choose another name. You may choose Private.
2. Extract this ZIP on your device. Open the new repository and use **Add file → Upload files** to upload the *contents* of the extracted folder, including the `.github/workflows/build-windows.yml` file and the `assets` folder. Commit the upload to the `main` branch.
3. Open the **Actions** tab in the repository you just created. The workflow should start automatically after the commit. If prompted, enable GitHub Actions.
4. Open the completed workflow run and download `MARKENS-Windows-x64-EXE` from **Artifacts**. Extract that downloaded ZIP; it should contain `MARKENS_Setup.exe` and `MARKENS_Portable.exe` if both targets build successfully.

Important: a URL like `https://github.com/markens/markens/actions` works only if a repository actually exists at that exact owner/repository path and you have access to it. Create your own repository first and open **Actions inside that repository**. A 404 at that example URL does not mean this archive failed to download.

## Local build (optional)

With Node.js 20+ installed, run `npm install` and then `npm run dist`. Outputs are placed in `dist/`.

## Important notes

- The workflow verifies that EXE files were produced before uploading an artifact; a successful workflow run is required before calling the result built.
- This package is not code-signed. Windows SmartScreen may show a warning for an unsigned installer.
- This project has not been runtime-tested on a Windows machine in this environment. Verify messaging, login, Firebase, microphone/camera, screen sharing, and other core features after building.
