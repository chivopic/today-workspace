const DB = "test1-workspace"; // Legacy key intentionally kept so existing installs retain data.
const VER = 2;
const BACKUP_FORMAT = "today-workspace-backup";
const BACKUP_VERSION = 2;
const LEGACY_BACKUP_VERSION = 1;
const DEVICE_ID_KEY = "today-workspace-device-id";

let view = "today";
let filter = "open";
let editing = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

function getOrCreateDeviceId() {
  const fallback = uid();
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    localStorage.setItem(DEVICE_ID_KEY, fallback);
  } catch (error) {
    console.warn("Unable to persist device id", error);
  }
  return fallback;
}

const DEVICE_ID = getOrCreateDeviceId();

function normalizeSyncRecord(record) {
  return {
    ...record,
    userId: record.userId ?? null,
    deviceId: typeof record.deviceId === "string" && record.deviceId ? record.deviceId : DEVICE_ID,
    version: Number.isInteger(record.version) && record.version > 0 ? record.version : 1,
    deletedAt: Number.isFinite(record.deletedAt) && record.deletedAt > 0 ? record.deletedAt : null,
    syncStatus: record.syncStatus === "synced" ? "synced" : "pending"
  };
}

function outboxEntry(storeName, record, operation = record.deletedAt ? "delete" : "upsert") {
  return {
    id: `${storeName}:${record.id}`,
    store: storeName,
    entityId: record.id,
    operation,
    record,
    deviceId: DEVICE_ID,
    queuedAt: Date.now()
  };
}

function migrateStore(storeName, transaction) {
  const store = transaction.objectStore(storeName);
  const outbox = transaction.objectStore("outbox");
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const record = normalizeSyncRecord(cursor.value);
    cursor.update(record);
    outbox.put(outboxEntry(storeName, record));
    cursor.continue();
  };
}

let databasePromise;

function db() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, VER);
    request.onupgradeneeded = event => {
      const database = request.result;
      if (!database.objectStoreNames.contains("notes")) database.createObjectStore("notes", { keyPath: "id" });
      if (!database.objectStoreNames.contains("tasks")) database.createObjectStore("tasks", { keyPath: "id" });
      if (!database.objectStoreNames.contains("outbox")) database.createObjectStore("outbox", { keyPath: "id" });

      if (event.oldVersion < 2 && event.oldVersion > 0) {
        migrateStore("notes", request.transaction);
        migrateStore("tasks", request.transaction);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      const reset = () => { databasePromise = null; };
      database.onversionchange = () => {
        database.close();
        reset();
      };
      database.onclose = reset;
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error);
    };
  });
  return databasePromise;
}

async function all(name, { includeDeleted = false } = {}) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction(name).objectStore(name).getAll();
    request.onsuccess = () => {
      const records = request.result || [];
      resolve(includeDeleted || name === "outbox" ? records : records.filter(record => !record.deletedAt));
    };
    request.onerror = () => reject(request.error);
  });
}

async function getOne(name, id) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction(name).objectStore(name).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeLocal(name, record, operation) {
  const database = await db();
  const normalized = normalizeSyncRecord({ ...record, syncStatus: "pending" });
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([name, "outbox"], "readwrite");
    transaction.objectStore(name).put(normalized);
    transaction.objectStore("outbox").put(outboxEntry(name, normalized, operation));
    transaction.oncomplete = () => resolve(normalized);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Local write aborted"));
  });
}

async function createLocal(name, fields) {
  const now = Date.now();
  return writeLocal(name, {
    id: uid(),
    ...fields,
    userId: null,
    deviceId: DEVICE_ID,
    version: 1,
    deletedAt: null,
    syncStatus: "pending",
    createdAt: now,
    updatedAt: now
  }, "upsert");
}

async function updateLocal(name, id, patch) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([name, "outbox"], "readwrite");
    const store = transaction.objectStore(name);
    const request = store.get(id);
    let next = null;
    request.onsuccess = () => {
      const current = request.result;
      if (!current || current.deletedAt) return;
      next = {
        ...normalizeSyncRecord(current),
        ...patch,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
        deviceId: DEVICE_ID,
        version: (Number.isInteger(current.version) && current.version > 0 ? current.version : 1) + 1,
        syncStatus: "pending"
      };
      store.put(next);
      transaction.objectStore("outbox").put(outboxEntry(name, next));
    };
    transaction.oncomplete = () => resolve(next);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Local update aborted"));
  });
}

async function softDelete(name, id) {
  return updateLocal(name, id, { deletedAt: Date.now() });
}

const icons = () => window.lucide?.createIcons({ attrs: { "stroke-width": 1.8 } });
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fmt = time => dateFormatter.format(new Date(time));
const empty = text => `<div class="empty">${text}</div>`;

function taskRow(task) {
  const element = document.createElement("div");
  element.className = `row task ${task.done ? "done" : ""}`;
  element.innerHTML = `<button class="check" aria-label="${task.done ? "标记未完成" : "完成任务"}"><i data-lucide="check"></i></button><div class="main"><p class="title"></p><div class="meta">${fmt(task.createdAt)}</div></div><div class="actions"><button class="icon trash" aria-label="删除任务" title="删除"><i data-lucide="trash-2"></i></button></div>`;
  $(".title", element).textContent = task.text;
  $(".check", element).onclick = async () => {
    await updateLocal("tasks", task.id, { done: !task.done });
    render();
  };
  $(".trash", element).onclick = async () => {
    await softDelete("tasks", task.id);
    render();
  };
  return element;
}

function noteRow(note) {
  const element = document.createElement("div");
  element.className = "row note";
  element.innerHTML = `<div class="main"><p class="title"></p><div class="meta">${fmt(note.updatedAt)}</div></div><div class="actions"><button class="icon trash" aria-label="删除记录" title="删除"><i data-lucide="trash-2"></i></button></div>`;
  const summary = note.text.replace(/\s+/g, " ").trim();
  $(".title", element).textContent = summary.length > 120 ? `${summary.slice(0, 120)}…` : summary;
  element.onclick = event => {
    if (!event.target.closest(".trash")) openEditor(note);
  };
  $(".trash", element).onclick = async () => {
    await softDelete("notes", note.id);
    render();
  };
  return element;
}

async function renderToday(revision) {
  const [tasks, notes] = await Promise.all([all("tasks"), all("notes")]);
  if (revision !== renderRevision) return;
  const taskContainer = $("#todayTasks");
  const noteContainer = $("#todayNotes");
  taskContainer.innerHTML = "";
  noteContainer.innerHTML = "";
  const openTasks = tasks.filter(task => !task.done).sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
  const recentNotes = notes.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);
  taskContainer.className = openTasks.length ? "list" : "";
  noteContainer.className = recentNotes.length ? "list" : "";
  if (!openTasks.length) taskContainer.innerHTML = empty("当前没有待完成任务");
  else openTasks.forEach(task => taskContainer.append(taskRow(task)));
  if (!recentNotes.length) noteContainer.innerHTML = empty("还没有记录");
  else recentNotes.forEach(note => noteContainer.append(noteRow(note)));
}

async function renderTasks(revision) {
  let tasks = await all("tasks");
  if (revision !== renderRevision) return;
  tasks.sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
  if (filter === "open") tasks = tasks.filter(task => !task.done);
  if (filter === "done") tasks = tasks.filter(task => task.done);
  const container = $("#tasksList");
  container.innerHTML = "";
  container.className = tasks.length ? "list" : "";
  if (!tasks.length) container.innerHTML = empty(filter === "done" ? "暂无已完成任务" : filter === "open" ? "当前没有待完成任务" : "还没有任务");
  else tasks.forEach(task => container.append(taskRow(task)));
}

async function renderNotes(revision) {
  const query = $("#notesSearch").value.trim().toLowerCase();
  let notes = await all("notes");
  if (revision !== renderRevision) return;
  notes.sort((a, b) => b.updatedAt - a.updatedAt);
  if (query) notes = notes.filter(note => note.text.toLowerCase().includes(query));
  const container = $("#notesList");
  container.innerHTML = "";
  container.className = notes.length ? "list" : "";
  if (!notes.length) container.innerHTML = empty(query ? "没有匹配的记录" : "还没有记录");
  else notes.forEach(note => container.append(noteRow(note)));
}

let renderRevision = 0;
let searchTimer;
async function render() {
  clearTimeout(searchTimer);
  const revision = ++renderRevision;
  await { today: renderToday, tasks: renderTasks, notes: renderNotes }[view](revision);
  if (revision === renderRevision) icons();
}

function nav(nextView) {
  view = nextView;
  $$(".view").forEach(element => element.classList.toggle("active", element.dataset.view === nextView));
  $$(".nav").forEach(element => element.classList.toggle("active", element.dataset.nav === nextView));
  $("#pageTitle").textContent = { today: "今天", notes: "记录", tasks: "任务" }[nextView];
  render();
}

function openEditor(note = null) {
  editing = note?.id || null;
  $("#editorTitle").textContent = note ? "编辑记录" : "新建记录";
  $("#editorText").value = note?.text || "";
  $("#editorDialog").showModal();
  setTimeout(() => $("#editorText").focus(), 50);
}

async function seed() {
  const [notes, tasks] = await Promise.all([
    all("notes", { includeDeleted: true }),
    all("tasks", { includeDeleted: true })
  ]);
  if (notes.length || tasks.length) return;
  const now = Date.now();
  await writeLocal("notes", {
    id: uid(),
    text: "这是一个本地优先的移动工作台。打开即记录，不要求先整理。",
    userId: null,
    deviceId: DEVICE_ID,
    version: 1,
    deletedAt: null,
    syncStatus: "pending",
    createdAt: now - 3600000,
    updatedAt: now - 3600000
  }, "upsert");
  await writeLocal("tasks", {
    id: uid(),
    text: "试着完成一个任务，再新增一条记录",
    done: false,
    userId: null,
    deviceId: DEVICE_ID,
    version: 1,
    deletedAt: null,
    syncStatus: "pending",
    createdAt: now - 1800000,
    updatedAt: now - 1800000
  }, "upsert");
}

function theme() {
  const saved = localStorage.getItem("test1-theme");
  const dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("#themeToggle").checked = dark;
}

function setBackupStatus(message) {
  $("#backupStatus").textContent = message;
}

function backupFilename() {
  return `today-workspace-backup-${new Date().toISOString().slice(0, 10)}.json`;
}

async function exportBackup() {
  try {
    const [notes, tasks] = await Promise.all([
      all("notes", { includeDeleted: true }),
      all("tasks", { includeDeleted: true })
    ]);
    const payload = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      schemaVersion: VER,
      deviceId: DEVICE_ID,
      exportedAt: new Date().toISOString(),
      notes,
      tasks
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = backupFilename();
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    const activeNotes = notes.filter(note => !note.deletedAt).length;
    const activeTasks = tasks.filter(task => !task.deletedAt).length;
    setBackupStatus(`已导出 ${activeNotes} 条记录、${activeTasks} 个任务。`);
  } catch (error) {
    console.error(error);
    setBackupStatus("导出失败，请重试。");
  }
}

const validTime = value => Number.isFinite(value) && value > 0 && value <= 8640000000000000;
const validId = value => typeof value === "string" && value.length > 0 && value.length <= 200;
const validNullableId = value => value == null || validId(value);
const validDeletedAt = value => value == null || validTime(value);
const validVersion = value => value == null || (Number.isInteger(value) && value > 0);
const validDeviceId = value => value == null || validId(value);
const validNote = note => note && validId(note.id) && typeof note.text === "string" && note.text.length <= 20000 && validTime(note.createdAt) && validTime(note.updatedAt) && validNullableId(note.userId) && validDeviceId(note.deviceId) && validVersion(note.version) && validDeletedAt(note.deletedAt);
const validTask = task => task && validId(task.id) && typeof task.text === "string" && task.text.length <= 5000 && typeof task.done === "boolean" && validTime(task.createdAt) && validTime(task.updatedAt) && validNullableId(task.userId) && validDeviceId(task.deviceId) && validVersion(task.version) && validDeletedAt(task.deletedAt);

function isNewer(candidate, existing) {
  if (!existing) return true;
  if (candidate.updatedAt !== existing.updatedAt) return candidate.updatedAt > existing.updatedAt;
  return (candidate.version || 1) > (existing.version || 1);
}

function normalizeNewest(records) {
  const map = new Map();
  records.forEach(record => {
    const normalized = normalizeSyncRecord(record);
    const existing = map.get(normalized.id);
    if (isNewer(normalized, existing)) map.set(normalized.id, normalized);
  });
  return [...map.values()];
}

async function mergeBackup(importedNotes, importedTasks) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["notes", "tasks", "outbox"], "readwrite");
    const outbox = transaction.objectStore("outbox");
    const counts = { notes: 0, tasks: 0 };
    for (const [name, records] of [["notes", importedNotes], ["tasks", importedTasks]]) {
      const store = transaction.objectStore(name);
      for (const record of normalizeNewest(records)) {
        const request = store.get(record.id);
        request.onsuccess = () => {
          if (!isNewer(record, request.result)) return;
          const normalized = normalizeSyncRecord({ ...record, syncStatus: "pending" });
          store.put(normalized);
          outbox.put(outboxEntry(name, normalized));
          counts[name] += 1;
        };
      }
    }
    transaction.oncomplete = () => resolve(counts);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Import aborted"));
  });
}

async function importBackup(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    setBackupStatus("备份文件过大，未导入。");
    return;
  }
  try {
    const payload = JSON.parse(await file.text());
    const supportedVersion = payload?.version === LEGACY_BACKUP_VERSION || payload?.version === BACKUP_VERSION;
    if (payload?.format !== BACKUP_FORMAT || !supportedVersion || !Array.isArray(payload.notes) || !Array.isArray(payload.tasks) || !payload.notes.every(validNote) || !payload.tasks.every(validTask)) throw new Error("Invalid backup format");
    const merged = await mergeBackup(payload.notes, payload.tasks);
    await render();
    setBackupStatus(merged.notes || merged.tasks ? `已合并 ${merged.notes} 条记录、${merged.tasks} 个任务；较新的本地内容会保留。` : "没有需要更新的数据；当前内容已经更新或相同。");
  } catch (error) {
    console.error(error);
    setBackupStatus("无法识别这个备份文件，未修改现有数据。");
  } finally {
    $("#importFile").value = "";
  }
}

$$('[data-nav]').forEach(button => { button.onclick = () => nav(button.dataset.nav); });

$("#captureForm").onsubmit = async event => {
  event.preventDefault();
  const input = $("#captureInput");
  const raw = input.value.trim();
  if (!raw) return;
  const isTask = /^\/task(\s|$)/i.test(raw);
  const text = isTask ? raw.replace(/^\/task\s*/i, "").trim() : raw;
  if (!text) return;
  if (isTask) await createLocal("tasks", { text, done: false });
  else await createLocal("notes", { text });
  input.value = "";
  render();
};

$("#taskForm").onsubmit = async event => {
  event.preventDefault();
  const input = $("#taskInput");
  const text = input.value.trim();
  if (!text) return;
  await createLocal("tasks", { text, done: false });
  input.value = "";
  render();
};

$$(".chip").forEach(chip => {
  chip.onclick = () => {
    filter = chip.dataset.filter;
    $$(".chip").forEach(element => element.classList.toggle("active", element === chip));
    render();
  };
});

$("#notesSearch").oninput = () => {
  // Invalidate in-flight results immediately, before the debounce expires.
  ++renderRevision;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => render(), 150);
};
$("#newNoteButton").onclick = () => openEditor();
$("#settingsButton").onclick = () => $("#settingsDialog").showModal();

$("#editorForm").onsubmit = async event => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const text = $("#editorText").value.trim();
  if (!text) return;
  if (editing) await updateLocal("notes", editing, { text, deletedAt: null });
  else await createLocal("notes", { text });
  $("#editorDialog").close();
  editing = null;
  render();
};

$("#themeToggle").onchange = event => {
  const nextTheme = event.target.checked ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem("test1-theme", nextTheme);
};

$("#exportButton").onclick = exportBackup;
$("#importButton").onclick = () => $("#importFile").click();
$("#importFile").onchange = event => importBackup(event.target.files?.[0]);

$("#dateLabel").textContent = new Intl.DateTimeFormat("zh-CN", { weekday: "long", month: "long", day: "numeric" }).format(new Date());

theme();
icons();
seed().then(render);
