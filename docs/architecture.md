# Data and sync

[English README](../README.md) · [中文 README](../README.zh-CN.md) · [Development](./development.md)

This document describes the v0.4.0 client in [`app.js`](../app.js) and [`cloud.js`](../cloud.js). The server-side SQL is not included in this repository; client behavior below is not a claim about an independently verified backend.

## Local storage

The app uses the historical IndexedDB name `test1-workspace` to preserve data from earlier installations. The current database schema is **v3**; the JSON backup format is independently versioned at **v2**.

```text
notes
  id / text / createdAt / updatedAt
  userId / deviceId / version / deletedAt / syncStatus

tasks
  id / text / done / createdAt / updatedAt
  userId / deviceId / version / deletedAt / syncStatus

outbox
  id / store / entityId / operation / record / deviceId / queuedAt
```

Creating, editing, completing, deleting, and restoring a record writes the entity and its outbox entry in one IndexedDB transaction. Deletes use a `deletedAt` tombstone so deletion can propagate across devices. The most recent deletion can be undone for six seconds, subject to the record still matching the deleted revision.

Schema v3 indexes `notes.updatedAt` and `tasks.createdAt`. Today reads up to four visible entries per store through those indexes rather than loading the full collection. Older schemas are upgraded without clearing records or the pending queue. The client shares its database connection, renders the active view, and debounces note search by 150 ms. These behaviors have regression coverage; they are not benchmark results.

New local stores start with one example note and task. Local saves guard against duplicate submissions, retain input on failure, and preserve text typed while a previous save is in progress. Theme preference and device identity use browser storage; the default theme follows the device when no override is saved. The notebook UI adapts from bottom navigation to a sidebar at 800 px and shows a lunar date when the browser supports the Chinese calendar.

Storage belongs to the browser profile and origin. A different port, host, or browser does not share it. Clearing site data removes local records; export before migrating or clearing storage.

## Backups

Use Settings → Export JSON / Import JSON. Export includes notes, tasks, deletion tombstones, schema version, device ID, and export time. It does not export an authentication session or the outbox as a separate store.

- Current format: `today-workspace-backup`, version `2`; version `1` is also accepted.
- Import validates the payload before merging and rejects files larger than 10 MiB.
- Records are deduplicated by ID and compared by `updatedAt`, then `version`.
- Import merges newer revisions without first clearing existing data. Imported changes enter the local sync queue.
- Deletion tombstones are preserved, so importing a backup can also apply newer deletions.

Quick capture accepts up to 180 characters, the task form 120, and the note editor 2,000. Backup validation accepts longer existing records: up to 20,000 characters per note and 5,000 per task.

## Sync behavior

Sync is optional; local capture does not require an account. Email registration, confirmation, password login, logout, and password recovery are exposed in Settings.

### Triggers and ordering

Sync runs on sign-in, startup with an existing session, reconnection, page visibility returning, and local changes. Settings also offers **立即同步** (Sync now). Local changes use a 300 ms debounce. Overlapping requests share one in-flight sync; edits made during that sync schedule another pass.

A pass first uploads the outbox, then pulls notes and tasks in parallel. Each pull orders by `id`, requests at most 500 rows, and uses the last ID to fetch the next page. This cursor exists only for that pass: every sync still scans the remote collection. There is no persistent incremental cursor or Realtime subscription.

### Revision handling

An upload acknowledges only the snapshot sent. If the user edits that record while the request is in flight, the newer version stays queued. Remote merges skip records with pending local changes. Other incoming records are compared by `updatedAt`, then `version`; remote changes refresh the view without replacing an editor draft.

This is the client-side merge rule, not a complete distributed conflict-resolution guarantee. The implementations of `sync_upsert_note` and `sync_upsert_task` must also be considered when evaluating multi-device conflicts.

### Failures and account binding

Failed uploads retain their queue entries. Settings shows the pending count, last successful sync time, progress, and failure messages. A user can retry manually or wait for another trigger; there is no independent exponential-backoff retry loop.

On the first sync, the local store is bound to the signed-in account and untouched starter examples are discarded. Signing into a different account pauses sync to avoid mixing data. Signing out does not create a separate local workspace. The client also stops acknowledging uploads or issuing further requests when the active account changes mid-sync.

## Cloud configuration

[`cloud.js`](../cloud.js) currently defines `SUPABASE_URL`, `SUPABASE_KEY`, and `AUTH_REDIRECT_URL` directly. There is no `.env` integration. The key in the browser client is public configuration, not a server secret; do not put service-role or secret keys in this client.

To connect an independent backend, you must supply:

1. Supabase Auth with email login and redirect URLs matching the intended deployment. Both confirmation and recovery use `AUTH_REDIRECT_URL`, which currently points to the hosted web app rather than localhost.
2. `notes` and `tasks` tables exposing `id`, `text`, `created_at`, `updated_at`, `version`, `deleted_at`, and `device_id`; task rows also use `done`.
3. RPCs named `sync_upsert_note` and `sync_upsert_task`, each accepting a `payload` object with those record fields.
4. Server-side ownership checks and row-level security for the authenticated user. The client pull does not add a user-ID filter, and upload payloads do not supply an owner ID, so isolation must be enforced by the backend.

**The repository does not contain the server schema, ownership model, RPC definitions, or migrations.** The list above describes the client's contract, not a complete provisioning recipe. Deploying the frontend alone does not reproduce an independent sync service. Cloud tests use mocks and cannot validate deployed database policies.

The [release guide](../RELEASE.md#current-beta-limitation) records the default Auth email sender's beta limitation and the need for dedicated SMTP before broad distribution.
