# Contributing to Today Workspace

Help make capturing a thought or a task dependable and easy. Bug reports, focused fixes, accessibility improvements, tests, and clearer documentation are welcome. Issues and pull requests can be written in English or Chinese.

[Project overview](./README.md) · [开发与使用说明](./README.zh-CN.md) · [Development guide](./docs/development.md) · [Data and sync](./docs/architecture.md)

## Find a useful change

Search existing [issues](https://github.com/chivopic/today-workspace/issues) and [pull requests](https://github.com/chivopic/today-workspace/pulls) before starting. Small fixes and documentation improvements can go straight to a PR. For a larger feature, dependency, storage change, or sync redesign, open an issue first to explain the problem and proposed scope.

Good places to help include reproducing a data-saving bug, improving keyboard or screen-reader use, adding a regression case for a sync race, and correcting a confusing setup step. The [roadmap](./docs/development.md#roadmap) records ideas, not promises that every feature will be accepted.

## Set up locally

Fork the repository on GitHub and clone your fork. Replace `YOUR_USERNAME` below with your GitHub username:

```bash
git clone https://github.com/YOUR_USERNAME/today-workspace.git
cd today-workspace
git switch -c docs/describe-your-change
npm ci
npm run dev
```

Use **Node.js 22.12+** and npm. The branch name is an example; choose one that describes your change. Vite prints the local URL, normally `http://localhost:5173`.

Local notes and tasks work without an account or `.env` file. Use sample data and a separate browser profile or local origin when testing storage changes. Browser storage is tied to the origin, including its port; export a backup before changing or clearing data you want to keep.

Cloud configuration currently points to the hosted service. Do not use production accounts or data for destructive tests. The server schema and RPC migrations are not in this repository; the [cloud configuration notes](./docs/architecture.md#cloud-configuration) describe that boundary. A frontend checkout alone is not an isolated cloud test environment.

## Keep changes consistent with the project

Use the existing plain JavaScript, HTML, and CSS conventions. Prefer a focused change over a new abstraction or dependency unless it solves a concrete problem.

When touching local data or sync, preserve these behaviors:

- Local capture works without waiting for the network or requiring login.
- Record changes and their outbox entries commit together; deletes retain tombstones.
- Failed saves preserve input, and an earlier save does not erase newer typing.
- Upload acknowledgments do not remove newer pending revisions; remote merges do not overwrite unsent edits.
- Database upgrades and backup imports preserve existing data. Keep legacy backup compatibility unless a migration is explicitly part of the change.
- Account changes do not mix one user's local data into another account.

Read [Data and sync](./docs/architecture.md) before changing these paths. If a change intentionally alters behavior, explain the migration and user-visible effect in the PR.

For UI changes, retain accessible names, keyboard operation, visible focus, and meaningful status messages. Check narrow and wide layouts and both themes. The product UI is currently Chinese; do not imply that translating the README adds an English UI.

## Verify the change

For code changes, run:

```bash
npm test
npm run build
```

The tests use Node's test runner, jsdom, fake-indexeddb, and mocked cloud requests. Add a regression test when fixing a behavioral bug, especially for persistence, concurrency, backups, or sync. Test the user-visible result or data invariant rather than copying the implementation into an assertion.

For a UI change, also open the app and try the affected interaction. To check the production bundle or PWA behavior:

```bash
npm run preview
```

Load it online before checking offline reopening. A successful build or mocked sync test does not verify real Auth emails, deployed database policies, native Android behavior, or multi-device sync. Record what you actually checked and what remains unverified. The current Android workflows do not run `npm test`, so a green Android badge does not replace the local test run.

Documentation-only changes need a check of links, commands, examples, and image paths; rerunning unrelated tests is not necessary. Use `git diff --check` to catch whitespace errors.

Android tooling and release verification are described in the [development guide](./docs/development.md#android) and [release guide](./RELEASE.md). Do not generate a replacement release key or publish a release as part of an ordinary contribution.

## Report a bug

Include enough detail for someone else to reproduce the issue:

- Browser and OS version, or Android app version; Web, installed PWA, or Android.
- Steps to reproduce, expected result, and actual result.
- Whether you were signed out or signed in, online or offline, and whether the problem involved local saving or sync.
- A small example or screenshot with private content removed; relevant console errors if available.

Use made-up notes and tasks. Do not attach a real backup, access tokens, passwords, account identifiers, or signing files. For a suspected security issue, avoid posting exploit details or affected private data in a public issue; arrange a private reporting channel with the maintainer first. The repository does not currently publish a dedicated security contact.

## Open a pull request

Target `main` and keep each PR centered on one problem. Describe:

1. The problem and the resulting behavior, with a before/after example when useful.
2. The approach and any data compatibility or migration implications.
3. Commands and manual checks you ran, their results, and checks you could not run.
4. Screenshots for visible UI changes, using sample content.

Update documentation when behavior or setup changes. Keep [README.md](./README.md) and [README.zh-CN.md](./README.zh-CN.md) aligned; put detailed engineering explanations in `docs/`. Use actual app captures for current UI previews and update the [capture details](./docs/development.md#screenshots).

Review the diff before submitting. Exclude generated `dist/`, `node_modules/`, incidental Android build outputs, secrets, and unrelated lockfile changes. If a dependency change is intentional, update its manifest and lockfile together and explain why it is needed. Keep release version changes separate unless the PR is specifically about a release.

## License and third-party material

Contributions to this project are provided under its [MIT License](./LICENSE). Only submit work you have the right to contribute. Preserve applicable notices, and include source and license information when adding third-party code, fonts, icons, or other assets; the project's license does not replace their own terms.
