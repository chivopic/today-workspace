import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { IDBFactory, IDBObjectStore, IDBIndex, IDBCursor } from "fake-indexeddb";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const iconSource = await readFile(new URL("../icons.js", import.meta.url), "utf8");

async function setup(t, { indexedDB = new IDBFactory(), beforeEval = () => {} } = {}) {
  const dom = new JSDOM(html, { url: "https://workspace.test", runScripts: "outside-only" });
  const { window } = dom;
  window.indexedDB = indexedDB;
  window.matchMedia = () => ({ matches: false });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  beforeEval(window);
  window.eval(iconSource);
  window.eval(source.replace("export { db, ready };", "window.ready = ready;") + `
    window.api = { db, all, getOne, createLocal, updateLocal, softDelete, mergeBackup,
      importBackup, render, nav, validNote, recent, seed, openEditor };
  `);
  await window.ready;
  t.after(async () => {
    (await window.api.db()).close();
    window.close();
  });
  return { window, document: window.document, api: window.api };
}

const record = (id, updatedAt, text = id) => ({ id, text, createdAt: 1, updatedAt });

test("capture preserves ordinary /task prefixes and recognizes actual commands", async t => {
  const { api, document } = await setup(t);
  const input = document.querySelector("#captureInput");
  for (const text of ["/tasklist", "/tasks shopping", "/TASK buy milk", "/task"]) {
    input.value = text;
    await document.querySelector("#captureForm").onsubmit({ preventDefault() {} });
  }
  const notes = await api.all("notes");
  assert.ok(notes.some(note => note.text === "/tasklist"));
  assert.ok(notes.some(note => note.text === "/tasks shopping"));
  const tasks = await api.all("tasks");
  assert.equal(tasks.length, 2);
  assert.ok(tasks.some(task => task.text === "buy milk"));
});

test("concurrent local patches preserve both changes and matching outbox revision", async t => {
  const { api } = await setup(t);
  const task = await api.createLocal("tasks", { text: "before", done: false });
  await Promise.all([
    api.updateLocal("tasks", task.id, { text: "after" }),
    api.updateLocal("tasks", task.id, { done: true })
  ]);
  const current = await api.getOne("tasks", task.id);
  assert.equal(current.text, "after");
  assert.equal(current.done, true);
  assert.equal(current.version, 3);
  assert.deepEqual((await api.getOne("outbox", `tasks:${task.id}`)).record, current);
});

test("an edit racing a deletion cannot resurrect the deleted record", async t => {
  const { api } = await setup(t);
  const note = await api.createLocal("notes", { text: "before" });
  await Promise.all([
    api.softDelete("notes", note.id),
    api.updateLocal("notes", note.id, { text: "after", deletedAt: null })
  ]);
  assert.ok((await api.getOne("notes", note.id)).deletedAt);
  assert.equal((await api.getOne("outbox", `notes:${note.id}`)).operation, "delete");
});

test("local edits remain newer when the device clock moves backwards", async t => {
  const { api, window } = await setup(t);
  const note = await api.createLocal("notes", { text: "before" });
  window.Date.now = () => note.updatedAt - 1000;
  const updated = await api.updateLocal("notes", note.id, { text: "after" });
  assert.ok(updated.updatedAt > note.updatedAt);
});

test("overlapping backup merges preserve the newest record", async t => {
  const { api } = await setup(t);
  await Promise.all([
    api.mergeBackup([record("import", 300, "newer")], []),
    api.mergeBackup([record("import", 200, "older")], [])
  ]);
  assert.equal((await api.getOne("notes", "import")).text, "newer");
  assert.equal((await api.getOne("outbox", "notes:import")).record.text, "newer");
});

test("backup merge deduplicates revisions and retains tombstones", async t => {
  const { api } = await setup(t);
  const counts = await api.mergeBackup([
    record("duplicate", 100),
    { ...record("duplicate", 200), deletedAt: 200, version: 2 }
  ], [{ ...record("task", 100), done: true }]);
  assert.equal(counts.notes, 1);
  assert.equal(counts.tasks, 1);
  assert.ok(!(await api.all("notes")).some(note => note.id === "duplicate"));
  assert.equal((await api.getOne("outbox", "notes:duplicate")).operation, "delete");
});

test("v1 and v2 backups import through the user workflow", async t => {
  const { api, document } = await setup(t);
  for (const version of [1, 2]) {
    await api.importBackup({ size: 100, text: async () => JSON.stringify({
      format: "today-workspace-backup", version,
      notes: [record(`v${version}`, 100)], tasks: []
    }) });
    assert.ok(await api.getOne("notes", `v${version}`));
    assert.match(document.querySelector("#backupStatus").textContent, /已合并 1/);
  }
  assert.equal(api.validNote(record("invalid", 1e20)), false);
});

test("one shared connection and only the visible view is read and rendered", async t => {
  const { api, document, window } = await setup(t);
  let opens = 0;
  const open = window.indexedDB.open.bind(window.indexedDB);
  window.indexedDB.open = (...args) => { opens++; return open(...args); };
  const reads = [];
  const originalCursor = IDBIndex.prototype.openCursor;
  t.mock.method(IDBIndex.prototype, "openCursor", function (...args) {
    reads.push(this.objectStore.name);
    return originalCursor.apply(this, args);
  });
  const original = IDBObjectStore.prototype.getAll;
  t.mock.method(IDBObjectStore.prototype, "getAll", function (...args) {
    reads.push(this.name);
    return original.apply(this, args);
  });
  await api.render();
  assert.deepEqual(reads.sort(), ["notes", "tasks"]);
  assert.equal(document.querySelector("#notesList").children.length, 0);
  assert.equal(document.querySelector("#tasksList").children.length, 0);
  reads.length = 0;
  api.nav("notes");
  // Wait for the navigation's transaction without triggering a second render.
  await new Promise(resolve => window.setTimeout(resolve, 30));
  assert.deepEqual(reads, ["notes"]);
  assert.ok(document.querySelector("#notesList .row"));
  assert.equal(opens, 0);
});

test("rapid search coalesces reads and refreshes result icons", async t => {
  const { api, document, window } = await setup(t);
  await api.createLocal("notes", { text: "needle" });
  api.nav("notes");
  await api.render();
  let reads = 0;
  const original = IDBObjectStore.prototype.getAll;
  t.mock.method(IDBObjectStore.prototype, "getAll", function (...args) {
    reads++;
    return original.apply(this, args);
  });
  const search = document.querySelector("#notesSearch");
  for (const value of ["n", "ne", "nee", "needle"]) {
    search.value = value;
    search.oninput();
  }
  await new Promise(resolve => window.setTimeout(resolve, 220));
  assert.equal(reads, 1);
  assert.equal(document.querySelectorAll("#notesList .row").length, 1);
  assert.equal(document.querySelector("#notesList .title").textContent, "needle");
  assert.ok(document.querySelector("#notesList .trash svg"));
});

test("late search results cannot replace the latest query", async t => {
  const { api, document, window } = await setup(t);
  api.nav("notes");
  await api.render();
  window.eval(`
    window.pendingReads = [];
    all = () => new Promise(resolve => window.pendingReads.push(resolve));
  `);
  document.querySelector("#notesSearch").value = "old";
  const oldRender = api.render();
  document.querySelector("#notesSearch").value = "new";
  const newRender = api.render();
  window.pendingReads[1]([record("new", 100, "new result")]);
  await newRender;
  window.pendingReads[0]([record("old", 100, "old result")]);
  await oldRender;
  assert.equal(document.querySelector("#notesList .title").textContent, "new result");
});

test("submitting twice saves once and preserves the next draft", async t => {
  const { api, document } = await setup(t);
  for (const [formId, inputId, store] of [
    ["captureForm", "captureInput", "notes"], ["taskForm", "taskInput", "tasks"]
  ]) {
    const input = document.getElementById(inputId);
    const form = document.getElementById(formId);
    input.value = "save once";
    const first = form.onsubmit({ preventDefault() {} });
    const duplicate = form.onsubmit({ preventDefault() {} });
    input.value = "next draft";
    await Promise.all([first, duplicate]);
    assert.equal((await api.all(store)).filter(row => row.text === "save once").length, 1);
    assert.equal(input.value, "next draft");
    assert.equal(form.querySelector("button").disabled, false);
  }
});

test("failed saves retain input, report failure and allow retry", async t => {
  const { api, document, window } = await setup(t);
  const original = IDBObjectStore.prototype.put;
  const failingPut = t.mock.method(IDBObjectStore.prototype, "put", function (...args) {
    if (this.name === "notes") throw new window.DOMException("Full", "QuotaExceededError");
    return original.apply(this, args);
  });
  t.mock.method(window.console, "error", () => {});
  const input = document.querySelector("#captureInput");
  input.value = "keep this";
  await document.querySelector("#captureForm").onsubmit({ preventDefault() {} });
  assert.equal(input.value, "keep this");
  assert.match(document.querySelector("#captureStatus").textContent, /保存失败/);
  failingPut.mock.restore();
  await document.querySelector("#captureForm").onsubmit({ preventDefault() {} });
  assert.equal((await api.all("notes")).filter(row => row.text === "keep this").length, 1);
});

test("editor keeps newer typing and subsequent saves update the created note", async t => {
  const { api, document } = await setup(t);
  api.openEditor();
  const input = document.querySelector("#editorText");
  const form = document.querySelector("#editorForm");
  input.value = "first version";
  const first = form.onsubmit({ preventDefault() {} });
  const duplicate = form.onsubmit({ preventDefault() {} });
  input.value = "continued writing";
  await Promise.all([first, duplicate]);
  assert.equal(document.querySelector("#editorDialog").open, true);
  assert.equal(input.value, "continued writing");
  const saved = (await api.all("notes")).find(row => row.text === "first version");
  await form.onsubmit({ preventDefault() {} });
  assert.equal(document.querySelector("#editorDialog").open, false);
  assert.equal((await api.getOne("notes", saved.id)).text, "continued writing");
  assert.equal((await api.all("notes")).length, 2);
});

test("an earlier editor save cannot close a newly opened draft", async t => {
  const { api, document } = await setup(t);
  api.openEditor();
  document.querySelector("#editorText").value = "save old session";
  const save = document.querySelector("#editorForm").onsubmit({ preventDefault() {} });
  document.querySelector("#editorDialog").close();
  api.openEditor();
  document.querySelector("#editorText").value = "new session draft";
  await save;
  assert.equal(document.querySelector("#editorDialog").open, true);
  assert.equal(document.querySelector("#editorText").value, "new session draft");
});

test("editing a deleted record keeps the draft and explains the failed save", async t => {
  const { api, document } = await setup(t);
  const note = await api.createLocal("notes", { text: "before" });
  api.openEditor(note);
  document.querySelector("#editorText").value = "unsaved draft";
  await api.softDelete("notes", note.id);
  await document.querySelector("#editorForm").onsubmit({ preventDefault() {} });
  assert.equal(document.querySelector("#editorDialog").open, true);
  assert.equal(document.querySelector("#editorText").value, "unsaved draft");
  assert.match(document.querySelector("#editorStatus").textContent, /已被删除/);
  assert.ok((await api.getOne("notes", note.id)).deletedAt);
});

test("preference storage failures do not prevent local startup or theme changes", async t => {
  const { api, document } = await setup(t, { beforeEval(window) {
    t.mock.method(window.Storage.prototype, "getItem", () => { throw new window.DOMException("Denied", "SecurityError"); });
    t.mock.method(window.Storage.prototype, "setItem", () => { throw new window.DOMException("Denied", "SecurityError"); });
    t.mock.method(window.console, "warn", () => {});
  } });
  assert.equal((await api.all("notes")).length, 1);
  document.querySelector("#themeToggle").onchange({ target: { checked: true } });
  assert.equal(document.documentElement.dataset.theme, "dark");
});

test("editing the maximum valid backup timestamp stays renderable", async t => {
  const { api } = await setup(t);
  await api.mergeBackup([record("max-time", 8640000000000000)], []);
  const updated = await api.updateLocal("notes", "max-time", { text: "updated" });
  assert.equal(api.validNote(updated), true);
  assert.equal(updated.version, 2);
  await api.render();
});

test("home reads just four indexed rows per store for large active collections", async t => {
  const { api, document } = await setup(t);
  const now = Date.now();
  await api.mergeBackup(
    Array.from({ length: 1000 }, (_, i) => record(`note-${i}`, now + i)),
    Array.from({ length: 1000 }, (_, i) => ({ ...record(`task-${i}`, now + i), createdAt: now + i, done: false }))
  );
  let fullReads = 0;
  let advances = 0;
  const getAll = IDBObjectStore.prototype.getAll;
  const advance = IDBCursor.prototype.continue;
  t.mock.method(IDBObjectStore.prototype, "getAll", function (...args) { fullReads++; return getAll.apply(this, args); });
  t.mock.method(IDBCursor.prototype, "continue", function (...args) { advances++; return advance.apply(this, args); });
  await api.render();
  assert.equal(fullReads, 0);
  assert.equal(advances, 6);
  assert.equal(document.querySelectorAll("#todayNotes .row").length, 4);
  assert.equal(document.querySelector("#todayNotes .title").textContent, "note-999");
  assert.equal(document.querySelector("#todayTasks .title").textContent, "task-999");
});

test("home skips deleted notes and completed or deleted tasks", async t => {
  const { api, document } = await setup(t);
  const now = Date.now();
  const notes = Array.from({ length: 8 }, (_, i) => record(`note-${i}`, now + i));
  const tasks = notes.map(note => ({ ...note, createdAt: note.updatedAt, done: false }));
  notes[7].deletedAt = now;
  tasks[7].done = true;
  tasks[6].deletedAt = now;
  await api.mergeBackup(notes, tasks);
  await api.render();
  assert.deepEqual([...document.querySelectorAll("#todayNotes .title")].map(node => node.textContent), ["note-6", "note-5", "note-4", "note-3"]);
  assert.deepEqual([...document.querySelectorAll("#todayTasks .title")].map(node => node.textContent), ["note-5", "note-4", "note-3", "note-2"]);
});

test("concurrent initialization seeds only one pair of examples", async t => {
  const { api } = await setup(t);
  const database = await api.db();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(["notes", "tasks", "outbox"], "readwrite");
    for (const name of ["notes", "tasks", "outbox"]) transaction.objectStore(name).clear();
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  await Promise.all([api.seed(), api.seed()]);
  assert.equal((await api.all("notes")).length, 1);
  assert.equal((await api.all("tasks")).length, 1);
  assert.equal((await api.all("outbox")).length, 2);
});

test("an empty bound account does not recreate discarded examples", async t => {
  const { api } = await setup(t, { beforeEval(window) {
    window.localStorage.setItem("today-workspace-bound-user", "user");
  } });
  assert.equal((await api.all("notes")).length, 0);
  assert.equal((await api.all("tasks")).length, 0);
});

for (const version of [1, 2]) {
  test(`schema v${version} upgrades with existing records and outbox intact`, async t => {
    const indexedDB = new IDBFactory();
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("test1-workspace", version);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore("notes", { keyPath: "id" }).put(record("existing", 100));
        database.createObjectStore("tasks", { keyPath: "id" });
        if (version === 2) database.createObjectStore("outbox", { keyPath: "id" }).put({ id: "preserved", record: record("pending", 200) });
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    const { api, document } = await setup(t, { indexedDB });
    assert.equal((await api.db()).version, 3);
    assert.equal(document.querySelector("#todayNotes .title").textContent, "existing");
    assert.equal((await api.all("notes")).length, 1);
    assert.ok(await api.getOne("outbox", version === 1 ? "notes:existing" : "preserved"));
  });
}

test("remote updates refresh the view without losing an editor draft", async t => {
  const { api, document, window } = await setup(t);
  api.openEditor();
  document.querySelector("#editorText").value = "keep typing";
  window.dispatchEvent(new window.Event("workspace:remote-change"));
  await api.render();
  assert.equal(document.querySelector("#editorDialog").open, true);
  assert.equal(document.querySelector("#editorText").value, "keep typing");
});
