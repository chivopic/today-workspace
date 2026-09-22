import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const iconSource = await readFile(new URL("../icons.js", import.meta.url), "utf8");

async function setup(t) {
  const dom = new JSDOM(html, { url: "https://workspace.test", runScripts: "outside-only" });
  const { window } = dom;
  window.indexedDB = new IDBFactory();
  window.matchMedia = () => ({ matches: false });
  window.eval(iconSource);
  window.eval(source.replace("seed().then(render);", "window.ready = seed().then(render);") + `
    window.api = { db, all, getOne, createLocal, updateLocal, softDelete, mergeBackup,
      importBackup, render, nav, validNote };
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
