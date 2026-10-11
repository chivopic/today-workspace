# Development and deployment

[English README](../README.md) · [中文 README](../README.zh-CN.md) · [Data and sync](./architecture.md)

## Run locally

Use Node.js **22.12 or newer** and npm. Although the project declares Node.js `>=22.0.0`, the pinned Vite 8.2.0 requires `^20.19.0 || >=22.12.0`, and Capacitor 8 requires `>=22.0.0`; 22.12+ satisfies both. The Android workflows select Node.js 22; [`package-lock.json`](../package-lock.json) pins dependencies.

```bash
npm ci
npm run dev
```

Vite prints the local URL, normally `http://localhost:5173`; it may choose another port if that port is busy. To keep browser storage on a stable origin, pass `-- --port 5173 --strictPort` to the dev command. No account is required to save local notes and tasks. The UI is currently Chinese.

Do not assume local registration or password-reset links return to your dev server: [`cloud.js`](../cloud.js) configures the hosted app as its Auth redirect. Read [cloud configuration](./architecture.md#cloud-configuration) before using another backend.

## Tests

```bash
npm test
```

The Node.js built-in test runner uses jsdom and fake-indexeddb. [`tests/app.test.js`](../tests/app.test.js) covers capture commands and modes, undo, draft preservation, write races, backup merges, schema upgrades, indexed home reads, and search behavior. [`tests/cloud.test.js`](../tests/cloud.test.js) covers upload acknowledgments, failed uploads, pagination beyond the API row limit, concurrent edits, automatic sync scheduling, sign-out, and account binding.

Cloud requests are mocked. These tests do not verify real email delivery, deployed RPCs or RLS, native Android behavior, or cross-device synchronization. Existing GitHub Actions workflows build Android artifacts; they do not run `npm test`.

## Build and preview

```bash
npm run build
npm run preview
```

The build writes `dist/`. Open the preview URL printed by Vite, normally `http://localhost:4173`. Vercel and Capacitor use the same Web bundle.

The production build generates a manifest and a Workbox Service Worker through `vite-plugin-pwa`. It precaches the matched app resources, including local fonts, and uses `index.html` as the navigation fallback. To check offline reopening, first load the production preview online and allow Service Worker installation and caching to complete, then reload offline. Merely opening the dev server does not validate this behavior.

## Project map

The frontend is plain JavaScript, HTML, and CSS. Build tooling is Vite 8, PWA support uses `vite-plugin-pwa` and Workbox, cloud integration uses Supabase, and Android uses Capacitor 8.

```text
index.html                  Page structure and dialogs
main.js                     Vite entry and module imports
app.js                      UI, IndexedDB, backups, local outbox
cloud.js                    Auth, account binding, cloud sync
auth-status.js              Chinese Auth error messages
recovery-ui.js              Password recovery dialog behavior
icons.js                    Local icon renderer
styles.css / cloud.css      Notebook and account styles
fonts/                      Local date numeral font
assets/                     Image assets
public/                     Shared PWA / Android icons
tests/                      Local and mocked cloud regression tests
docs/                       Technical documentation and screenshots
scripts/                    Android release configuration helper
.github/workflows/          Android debug and signed release builds
vite.config.js              Web build and PWA manifest
capacitor.config.json       App ID, name, Web bundle directory
```

The Android application ID is `io.chivopic.today`. Current source version is `0.4.0`; release workflow defaults are versionName `0.4.0` and versionCode `6`.

## Android

Prepare Android Studio, JDK 21, and Android SDK 36. CI uses Build Tools 36.0.0. The generated `android/` project is not included in the repository.

After installing npm dependencies, create it once:

```bash
npm run build
npm run android:add
```

For later Web changes:

```bash
npm run android:sync
```

To rebuild, sync, and open Android Studio:

```bash
npm run android:open
```

[`Today Workspace Android`](../.github/workflows/today-workspace-android.yml) builds a debug APK on pushes to `main`, pull requests, or manual dispatch. Its artifact is retained for 14 days.

[`Today Workspace Release`](../.github/workflows/today-workspace-release.yml) smoke-tests release-related PR changes with an ephemeral CI key. Manual dispatch builds signed APK and AAB files using repository signing secrets, verifies signatures, computes SHA-256 checksums, and creates a GitHub Release. Release artifacts are also retained in Actions for 90 days.

Follow [RELEASE.md](../RELEASE.md) for signing secrets, key continuity, version increments, checksums, and the physical-device checklist. Never commit keystores or their credentials. No Android build or publication is required for frontend documentation work.

## Hosting

For the existing Vercel deployment, use the repository root:

| Setting | Value |
| --- | --- |
| Repository | `chivopic/today-workspace` |
| Branch | `main` |
| Root directory | `./` |
| Build command | `npm run build` |
| Output directory | `dist` |

The build uses a relative asset base (`./`). When changing the deployment origin, review the Auth redirect and backend requirements in [Data and sync](./architecture.md#cloud-configuration). This repository does not provision the cloud database.

## Screenshots

The README images were captured on 2026-10-11 from the locally running v0.4.0 app (source commit `32d52b4`), using sample content entered through the UI while signed out. The desktop viewport was 1280 × 720 with a full-page capture; the mobile viewport was 390 × 844:

- [`desktop-light.jpg`](./screenshots/desktop-light.jpg): Today with wide-screen sidebar navigation.
- [`mobile-light.jpg`](./screenshots/mobile-light.jpg): Today at a narrow viewport, light theme.
- [`mobile-dark.jpg`](./screenshots/mobile-dark.jpg): the same responsive view with the app's dark theme enabled.

These are browser screenshots, not Android-device screenshots or generated mockups. To refresh them, run the app on a separate local origin, enter non-private sample notes and tasks, capture the desktop and narrow layouts, and switch theme through Settings. Keep personal data and account identifiers out of the images.

The older [`today-light.svg`](./screenshots/today-light.svg) and [`settings-dark.svg`](./screenshots/settings-dark.svg) are historical illustrations. They are retained for reference but are not used as current UI previews.

## Roadmap

These items are not implemented commitments or release dates:

- Persistent incremental pull cursors across sync runs; single-run pagination already exists.
- More explicit multi-device conflict handling.
- Automatic backoff retry and more detailed sync diagnostics; basic status is already shown.
- Task dates and reminders.
- Native system sharing integration.
- Browser end-to-end tests and real multi-device sync verification.
- More complete Android device release verification and a maintained changelog; signed releases already have a workflow.

Longer-term ideas retained from the original README: a workspace search assistant, semantic search, AI task extraction, a knowledge graph, and personal second-brain integration. None is presented as an available feature.
