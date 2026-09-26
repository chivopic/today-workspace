import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM, VirtualConsole } from "jsdom";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const source = (await readFile(new URL("../cloud.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "");
const clone = value => structuredClone(value);
const revision = (id, version = 1, updatedAt = version * 100) => ({
  id, text: `revision ${version}`, createdAt: 1, updatedAt, version,
  deletedAt: null, deviceId: "test-device", userId: null, syncStatus: "pending"
});
const remote = value => ({
  id: value.id, text: value.text, created_at: value.createdAt, updated_at: value.updatedAt,
  version: value.version, deleted_at: value.deletedAt, device_id: value.deviceId,
  ...(typeof value.done === "boolean" ? { done: value.done } : {})
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function setup(t) {
  const browserErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => browserErrors.push(error));
  const dom = new JSDOM(html, { url: "https://workspace.test", runScripts: "outside-only", virtualConsole });
  const { window } = dom;
  const factory = new IDBFactory();
  let opens = 0;
  const database = await new Promise((resolve, reject) => {
    const request = factory.open("test-cloud", 1);
    request.onupgradeneeded = () => {
      for (const name of ["notes", "tasks", "outbox"]) request.result.createObjectStore(name, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  window.indexedDB = { open: (...args) => { opens++; return factory.open(...args); } };
  const state = { session: null, calls: [], reads: [], rows: { notes: [], tasks: [] }, rowCap: 500, errors: [], browserErrors };
  const client = {
    auth: {
      getSession: async () => state.getSession ? state.getSession() : { data: { session: state.session }, error: null },
      onAuthStateChange: callback => { state.onAuth = callback; }
    },
    rpc: async (fn, args) => {
      state.calls.push({ fn, ...clone(args) });
      return state.rpc ? state.rpc(fn, args) : { error: null };
    },
    from: storeName => {
      const request = { storeName, after: null, limit: 500 };
      const query = {
        select: () => query,
        order: column => { assert.equal(column, "id"); return query; },
        limit: value => { request.limit = value; return query; },
        gt: (column, value) => { assert.equal(column, "id"); request.after = value; return query; },
        then: (resolve, reject) => {
          state.reads.push({ ...request });
          const result = state.select ? state.select(request) : {
            data: clone(state.rows[storeName].filter(row => request.after === null || row.id > request.after)
              .sort((left, right) => left.id.localeCompare(right.id)).slice(0, Math.min(request.limit, state.rowCap))),
            error: null
          };
          return Promise.resolve(result).then(resolve, reject);
        }
      };
      return query;
    }
  };
  window.testClient = client;
  window.testDb = () => Promise.resolve(database);
  window.console.error = (...args) => state.errors.push(args);
  window.eval(`window.cloudReady = (async () => {
    const createClient = () => window.testClient;
    const db = window.testDb;
    const ready = Promise.resolve();
    ${source}
    window.cloudApi = { pushOutbox, pullStore, mergeRemotePage, syncNow, renderSession,
      countPending, refreshSyncMeta, ensureUserBinding };
  })();`);
  await window.cloudReady;
  const api = window.cloudApi;
  const session = { user: { id: "user-1", email: "test@example.test" } };
  const login = () => {
    state.session = session;
    window.localStorage.setItem("today-workspace-bound-user", session.user.id);
    api.renderSession(session);
  };
  const write = (storeName, value, pending = true) => new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName, "outbox"], "readwrite");
    transaction.objectStore(storeName).put(clone(value));
    if (pending) transaction.objectStore("outbox").put({
      id: `${storeName}:${value.id}`, store: storeName, entityId: value.id,
      operation: value.deletedAt ? "delete" : "upsert", record: clone(value), queuedAt: Date.now()
    });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  const read = (storeName, id) => new Promise((resolve, reject) => {
    const request = database.transaction(storeName).objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  t.after(() => { window.close(); database.close(); });
  return { window, document: window.document, api, state, login, write, read, opens: () => opens };
}

test("an upload only acknowledges its own snapshot and preserves edits made in flight", async t => {
  const { api, state, write, read } = await setup(t);
  await write("notes", revision("note"));
  const started = deferred();
  const response = deferred();
  state.rpc = () => { started.resolve(); return response.promise; };
  const upload = api.pushOutbox("user-1");
  await started.promise;
  await write("notes", revision("note", 2));
  response.resolve({ error: null });
  await upload;
  assert.equal((await read("outbox", "notes:note")).record.version, 2);
  assert.equal((await read("notes", "note")).syncStatus, "pending");
  state.rpc = null;
  await api.pushOutbox("user-1");
  assert.equal(await read("outbox", "notes:note"), undefined);
  assert.equal((await read("notes", "note")).syncStatus, "synced");
});

test("failed uploads retain the record and outbox for retry", async t => {
  const { api, state, write, read } = await setup(t);
  await write("notes", revision("note"));
  state.rpc = async () => ({ error: new Error("offline") });
  await assert.rejects(api.pushOutbox("user-1"), /offline/);
  assert.equal((await read("outbox", "notes:note")).record.version, 1);
  assert.equal((await read("notes", "note")).syncStatus, "pending");
});

test("pull does not overwrite local edits arriving during the network request", async t => {
  const { api, state, write, read } = await setup(t);
  await write("notes", { ...revision("note"), syncStatus: "synced" }, false);
  const started = deferred();
  const response = deferred();
  state.select = ({ after }) => {
    if (after) return { data: [], error: null };
    started.resolve();
    return response.promise;
  };
  const pull = api.pullStore("notes", "user-1");
  await started.promise;
  await write("notes", revision("note", 2));
  response.resolve({ data: [remote(revision("note", 3))], error: null });
  assert.equal(await pull, 0);
  assert.equal((await read("notes", "note")).version, 2);
  assert.equal((await read("outbox", "notes:note")).record.version, 2);
});

test("remote merge and concurrent local transactions preserve the pending local revision", async t => {
  const { api, write, read } = await setup(t);
  await write("notes", { ...revision("note"), syncStatus: "synced" }, false);
  await Promise.all([
    api.mergeRemotePage("notes", [remote(revision("note", 2))], "user-1"),
    write("notes", revision("note", 3))
  ]);
  assert.equal((await read("notes", "note")).version, 3);
  assert.equal((await read("outbox", "notes:note")).record.version, 3);
});

test("pull paginates beyond the API row cap and keeps remote tombstones", async t => {
  const { api, state, read } = await setup(t);
  state.rowCap = 200;
  state.rows.notes = Array.from({ length: 1205 }, (_, index) => remote({
    ...revision(`note-${String(index).padStart(4, "0")}`),
    ...(index === 1204 ? { deletedAt: 100 } : {})
  }));
  assert.equal(await api.pullStore("notes", "user-1"), 1205);
  assert.equal((await read("notes", "note-1204")).deletedAt, 100);
  assert.equal(state.reads.length, 8);
});

test("overlapping sync requests share one flight before session lookup finishes", async t => {
  const { api, state, login, write } = await setup(t);
  login();
  await write("notes", revision("note"));
  const sessionResponse = deferred();
  let sessions = 0;
  state.getSession = () => { sessions++; return sessionResponse.promise; };
  const first = api.syncNow();
  const second = api.syncNow();
  assert.equal(first, second);
  sessionResponse.resolve({ data: { session: state.session }, error: null });
  await Promise.all([first, second]);
  assert.equal(sessions, 1);
  assert.equal(state.calls.length, 1);
  assert.equal(state.reads.length, 2);
});

test("a failed parallel pull keeps the flight occupied until the other pull settles", async t => {
  const { api, state, login } = await setup(t);
  login();
  const started = deferred();
  const slowResponse = deferred();
  state.select = ({ storeName }) => {
    if (storeName === "notes") return { data: null, error: new Error("request failed") };
    started.resolve();
    return slowResponse.promise;
  };
  const first = api.syncNow();
  await started.promise;
  assert.equal(api.syncNow(), first);
  slowResponse.resolve({ data: [], error: null });
  await first;
  assert.equal(state.reads.length, 2);
  assert.equal(state.errors.length, 1);
});

test("session lookup failures are handled and the next sync can retry", async t => {
  const { api, state, login, document } = await setup(t);
  login();
  state.getSession = async () => { throw new Error("auth unavailable"); };
  await api.syncNow();
  assert.match(document.querySelector("#cloudStatus").textContent, /同步失败/);
  state.getSession = null;
  await api.syncNow();
  assert.match(document.querySelector("#cloudStatus").textContent, /同步完成/);
});

test("remote changes refresh the view without replacing unsaved draft inputs", async t => {
  const { api, state, login, document, window } = await setup(t);
  login();
  const input = document.querySelector("#captureInput");
  input.value = "unsaved draft";
  let changes = 0;
  window.addEventListener("workspace:remote-change", () => changes++);
  state.rows.notes = [remote(revision("remote-note"))];
  await api.syncNow();
  assert.equal(changes, 1);
  assert.equal(input.value, "unsaved draft");
  assert.equal(window.location.href, "https://workspace.test/");
  assert.deepEqual(state.browserErrors, []);
});

test("sync metadata counts outbox rows without materializing records or opening new connections", async t => {
  const { api, write, opens } = await setup(t);
  await write("notes", revision("note"));
  let getAllCalls = 0;
  const original = IDBObjectStore.prototype.getAll;
  t.mock.method(IDBObjectStore.prototype, "getAll", function (...args) {
    getAllCalls++;
    return original.apply(this, args);
  });
  await api.refreshSyncMeta();
  await api.refreshSyncMeta();
  assert.equal(await api.countPending(), 1);
  assert.equal(getAllCalls, 0);
  assert.equal(opens(), 0);
});

test("signing out during an upload prevents acknowledgment and further cloud requests", async t => {
  const { api, state, login, write, read } = await setup(t);
  login();
  await write("notes", revision("note"));
  const started = deferred();
  const response = deferred();
  state.rpc = () => { started.resolve(); return response.promise; };
  const sync = api.syncNow();
  await started.promise;
  state.session = null;
  state.onAuth("SIGNED_OUT", null);
  response.resolve({ error: null });
  await sync;
  assert.ok(await read("outbox", "notes:note"));
  assert.equal(state.reads.length, 0);
  assert.equal(state.errors.length, 0);
});

test("a stale session lookup cannot restart sync after sign-out", async t => {
  const { api, state, login, write } = await setup(t);
  login();
  await write("notes", revision("note"));
  const oldSession = state.session;
  const started = deferred();
  const response = deferred();
  state.getSession = () => { started.resolve(); return response.promise; };
  const sync = api.syncNow();
  await started.promise;
  state.session = null;
  state.onAuth("SIGNED_OUT", null);
  response.resolve({ data: { session: oldSession }, error: null });
  await sync;
  assert.equal(state.calls.length, 0);
  assert.equal(state.reads.length, 0);
});

test("local change events debounce automatic sync", { timeout: 3000 }, async t => {
  const { api, state, login, write, window } = await setup(t);
  login();
  await write("notes", revision("note"));
  const started = deferred();
  let sessions = 0;
  state.getSession = async () => {
    sessions++;
    started.resolve();
    return { data: { session: state.session }, error: null };
  };
  for (let index = 0; index < 6; index++) window.dispatchEvent(new window.Event("workspace:local-change"));
  await started.promise;
  await api.syncNow();
  assert.equal(sessions, 1);
  assert.equal(state.calls.length, 1);
});

test("edits made during sync automatically start a follow-up upload", { timeout: 3000 }, async t => {
  const { api, state, login, write, read, window } = await setup(t);
  login();
  await write("notes", revision("note"));
  const firstStarted = deferred();
  const response = deferred();
  const secondStarted = deferred();
  state.rpc = () => {
    if (state.calls.length === 1) { firstStarted.resolve(); return response.promise; }
    secondStarted.resolve();
    return { error: null };
  };
  const first = api.syncNow();
  await firstStarted.promise;
  await write("notes", revision("note", 2));
  window.dispatchEvent(new window.Event("workspace:local-change"));
  response.resolve({ error: null });
  await first;
  await secondStarted.promise;
  await api.syncNow();
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[1].payload.version, 2);
  assert.equal(await read("outbox", "notes:note"), undefined);
});

test("a different account cannot upload this device's bound data", async t => {
  const { api, state, login, write, window, document } = await setup(t);
  login();
  await write("notes", revision("note"));
  window.localStorage.setItem("today-workspace-bound-user", "another-user");
  await api.syncNow();
  assert.equal(state.calls.length, 0);
  assert.equal(state.reads.length, 0);
  assert.match(document.querySelector("#cloudStatus").textContent, /绑定另一个账号/);
});
