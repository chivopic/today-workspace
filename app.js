const DB = "test1-workspace"; // Legacy key intentionally kept so existing installs retain data.
const VER = 3;
const BACKUP_FORMAT = "today-workspace-backup";
const BACKUP_VERSION = 2;
const LEGACY_BACKUP_VERSION = 1;
const DEVICE_ID_KEY = "today-workspace-device-id";

let view = "today";
let filter = "open";
let captureMode = "note";
let editing = null;
let editorRevision = 0;

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

      for (const [name, key] of [["notes", "updatedAt"], ["tasks", "createdAt"]]) {
        const store = request.transaction.objectStore(name);
        if (!store.indexNames.contains(key)) store.createIndex(key, key);
      }

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

async function recent(name, key, limit, matches = () => true) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(name);
    const request = transaction.objectStore(name).index(key).openCursor(null, "prev");
    const records = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (!cursor.value.deletedAt && matches(cursor.value)) records.push(cursor.value);
      if (records.length < limit) cursor.continue();
    };
    transaction.oncomplete = () => resolve(records);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Read aborted"));
  });
}

function notifyLocalChange() {
  window.dispatchEvent(new Event("workspace:local-change"));
}

async function writeLocal(name, record, operation) {
  const database = await db();
  const normalized = normalizeSyncRecord({ ...record, syncStatus: "pending" });
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([name, "outbox"], "readwrite");
    transaction.objectStore(name).put(normalized);
    transaction.objectStore("outbox").put(outboxEntry(name, normalized, operation));
    transaction.oncomplete = () => {
      notifyLocalChange();
      resolve(normalized);
    };
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
        updatedAt: Math.min(8640000000000000, Math.max(Date.now(), current.updatedAt + 1)),
        deviceId: DEVICE_ID,
        version: (Number.isInteger(current.version) && current.version > 0 ? current.version : 1) + 1,
        syncStatus: "pending"
      };
      store.put(next);
      transaction.objectStore("outbox").put(outboxEntry(name, next));
    };
    transaction.oncomplete = () => {
      if (next) notifyLocalChange();
      resolve(next);
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Local update aborted"));
  });
}

async function softDelete(name, id) {
  return updateLocal(name, id, { deletedAt: Date.now() });
}

async function restoreLocal(name, id, expectedVersion) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([name, "outbox"], "readwrite");
    const store = transaction.objectStore(name);
    const request = store.get(id);
    let restored = null;
    request.onsuccess = () => {
      const current = request.result;
      if (!current?.deletedAt || current.version !== expectedVersion) return;
      restored = {
        ...normalizeSyncRecord(current),
        deletedAt: null,
        updatedAt: Math.min(8640000000000000, Math.max(Date.now(), current.updatedAt + 1)),
        deviceId: DEVICE_ID,
        version: current.version + 1,
        syncStatus: "pending"
      };
      store.put(restored);
      transaction.objectStore("outbox").put(outboxEntry(name, restored, "upsert"));
    };
    transaction.oncomplete = () => {
      if (restored) notifyLocalChange();
      resolve(restored);
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Local restore aborted"));
  });
}

let undoTimer;
let undoTarget = null;

function clearUndo() {
  clearTimeout(undoTimer);
  undoTarget = null;
  $("#undoToast").hidden = true;
}

function offerUndo(name, record) {
  clearUndo();
  undoTarget = { name, id: record.id, version: record.version };
  $("#undoMessage").textContent = name === "tasks" ? "任务已删除" : "记录已删除";
  $("#undoToast").hidden = false;
  undoTimer = setTimeout(clearUndo, 6000);
}

const icons = () => window.lucide?.createIcons({ attrs: { "stroke-width": 1.8 } });
const clockFormatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const startOfDay = time => new Date(time).setHours(0, 0, 0, 0);

// Short margin stamp: "11:42" today, "昨天" yesterday, "9/27" this year, "25/9/27" before.
function stamp(time) {
  const date = new Date(time);
  const today = startOfDay(Date.now());
  const day = startOfDay(time);
  if (day === today) return clockFormatter.format(date);
  if (day === new Date(today).setDate(new Date(today).getDate() - 1)) return "昨天";
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
  return date.getFullYear() === new Date(Date.now()).getFullYear() ? monthDay : `${String(date.getFullYear()).slice(-2)}/${monthDay}`;
}

const empty = (title, detail) => `<p class="empty">${title}<span>${detail}</span></p>`;

function taskRow(task) {
  const element = document.createElement("div");
  element.className = `row task ${task.done ? "done" : ""}`;
  element.innerHTML = `<button class="check" aria-label="${task.done ? "标记未完成" : "完成任务"}"><i data-lucide="check"></i></button><div class="main"><p class="title"></p></div><button class="trash" aria-label="删除任务" title="删除任务"><i data-lucide="x"></i></button>`;
  $(".title", element).textContent = task.text;
  $(".check", element).onclick = async () => {
    await updateLocal("tasks", task.id, { done: !task.done });
    render();
  };
  $(".trash", element).onclick = async () => {
    const deleted = await softDelete("tasks", task.id);
    render();
    if (deleted) offerUndo("tasks", deleted);
  };
  return element;
}

function noteRow(note) {
  const element = document.createElement("div");
  element.className = "row note";
  element.innerHTML = `<time class="stamp" datetime="${new Date(note.updatedAt).toISOString()}">${stamp(note.updatedAt)}</time><button class="note-open"><span class="title"></span></button><button class="trash" aria-label="删除记录" title="删除记录"><i data-lucide="x"></i></button>`;
  const summary = note.text.replace(/\s+/g, " ").trim();
  $(".title", element).textContent = summary.length > 120 ? `${summary.slice(0, 120)}…` : summary;
  $(".note-open", element).onclick = () => openEditor(note);
  $(".trash", element).onclick = async () => {
    const deleted = await softDelete("notes", note.id);
    render();
    if (deleted) offerUndo("notes", deleted);
  };
  return element;
}

async function renderToday(revision) {
  const [openTasks, recentNotes] = await Promise.all([
    recent("tasks", "createdAt", 4, task => !task.done),
    recent("notes", "updatedAt", 4)
  ]);
  if (revision !== renderRevision) return;
  const taskContainer = $("#todayTasks");
  const noteContainer = $("#todayNotes");
  taskContainer.innerHTML = "";
  noteContainer.innerHTML = "";
  taskContainer.className = openTasks.length ? "list" : "";
  noteContainer.className = recentNotes.length ? "list" : "";
  if (!openTasks.length) taskContainer.innerHTML = empty("待办都完成了。", "在上面切到“任务”，记下下一件事。");
  else openTasks.forEach(task => taskContainer.append(taskRow(task)));
  if (!recentNotes.length) noteContainer.innerHTML = empty("还没有记录。", "在上面写下第一个想法。");
  else recentNotes.forEach(note => noteContainer.append(noteRow(note)));
}

async function renderTasks(revision) {
  let tasks = await all("tasks");
  if (revision !== renderRevision) return;
  if (filter === "open") tasks = tasks.filter(task => !task.done);
  if (filter === "done") tasks = tasks.filter(task => task.done);
  tasks.sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
  const container = $("#tasksList");
  container.innerHTML = "";
  container.className = tasks.length ? "list" : "";
  if (!tasks.length) container.innerHTML = filter === "done" ? empty("还没有完成的任务。", "勾掉一件，它就会出现在这里。") : filter === "open" ? empty("待办已经清空。", "在上面写下下一件事。") : empty("还没有任务。", "在上面添加第一个任务。");
  else tasks.forEach(task => container.append(taskRow(task)));
}

async function renderNotes(revision) {
  const query = $("#notesSearch").value.trim().toLowerCase();
  let notes = await all("notes");
  if (revision !== renderRevision) return;
  if (query) notes = notes.filter(note => note.text.toLowerCase().includes(query));
  notes.sort((a, b) => b.updatedAt - a.updatedAt);
  const container = $("#notesList");
  container.innerHTML = "";
  container.className = notes.length ? "list" : "";
  if (!notes.length) container.innerHTML = query ? empty("没有找到相关记录。", "换个更短的关键词试试。") : empty("还没有记录。", "点“新建”写下第一个想法。");
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
  $$(".nav").forEach(element => {
    const active = element.dataset.nav === nextView;
    element.classList.toggle("active", active);
    if (active) element.setAttribute("aria-current", "page");
    else element.removeAttribute("aria-current");
  });
  $("#pageTitle").textContent = { today: "今天", notes: "记录", tasks: "任务" }[nextView];
  $("#top").dataset.view = nextView;
  renderDate();
  render();
}

function openEditor(note = null) {
  ++editorRevision;
  editing = note?.id || null;
  $("#editorTitle").textContent = note ? "编辑记录" : "新建记录";
  $("#editorText").value = note?.text || "";
  $("#editorStatus").textContent = "";
  $("#editorDialog").showModal();
  setTimeout(() => $("#editorText").focus(), 50);
}

async function seed() {
  // An empty account must stay empty after its examples have been discarded.
  try {
    if (localStorage.getItem("today-workspace-bound-user")) return;
  } catch { /* IndexedDB remains usable when preference storage is unavailable. */ }
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["notes", "tasks", "outbox"], "readwrite");
    const notes = transaction.objectStore("notes").count();
    const tasks = transaction.objectStore("tasks").count();
    let remaining = 2;
    let seeded = false;
    const onCount = () => {
      if (--remaining || notes.result || tasks.result) return;
      const now = Date.now();
      for (const [name, fields, age] of [
        ["notes", { text: "这是一个本地优先的移动工作台。打开即记录，不要求先整理。" }, 3600000],
        ["tasks", { text: "试着完成一个任务，再新增一条记录", done: false }, 1800000]
      ]) {
        const record = normalizeSyncRecord({ id: uid(), ...fields, createdAt: now - age, updatedAt: now - age });
        transaction.objectStore(name).put(record);
        transaction.objectStore("outbox").put(outboxEntry(name, record));
      }
      seeded = true;
    };
    notes.onsuccess = onCount;
    tasks.onsuccess = onCount;
    transaction.oncomplete = () => {
      if (seeded) notifyLocalChange();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Initialization aborted"));
  });
}

function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  $('meta[name="theme-color"]')?.setAttribute("content", name === "dark" ? "#15161a" : "#f4f3ef");
}

function theme() {
  let saved;
  try { saved = localStorage.getItem("test1-theme"); } catch { /* Use the device theme. */ }
  const dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(dark ? "dark" : "light");
  $("#themeToggle").checked = dark;
}

const CN_MONTHS = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
const weekdayFormatter = new Intl.DateTimeFormat("zh-CN", { weekday: "long" });

function lunarLabel(date) {
  try {
    const parts = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", { month: "long", day: "numeric" }).formatToParts(date);
    const month = parts.find(part => part.type === "month")?.value;
    const rawDay = parts.find(part => part.type === "day")?.value;
    if (!month || !rawDay) return "";
    const day = Number(rawDay);
    // Some engines already return the day in Chinese (e.g. "十八"); use it as-is.
    if (!Number.isInteger(day)) return `农历${month}${rawDay}`;
    if (day < 1 || day > 30) return "";
    const digits = "一二三四五六七八九十";
    const name = day <= 10 ? `初${digits[day - 1]}` : day < 20 ? `十${digits[day - 11]}` : day === 20 ? "二十" : day < 30 ? `廿${digits[day - 21]}` : "三十";
    return `农历${month}${name}`;
  } catch {
    return "";
  }
}

function renderDate() {
  const now = new Date();
  const weekday = weekdayFormatter.format(now);
  $("#dayNumber").textContent = String(now.getDate());
  if (view === "today") {
    $("#dateLabel").textContent = [`${CN_MONTHS[now.getMonth()]} ${weekday}`, lunarLabel(now)].filter(Boolean).join(" · ");
  } else {
    $("#dateLabel").textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${weekday}`;
  }
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
    transaction.oncomplete = () => {
      if (counts.notes || counts.tasks) notifyLocalChange();
      resolve(counts);
    };
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

$("#undoButton").onclick = async () => {
  const target = undoTarget;
  if (!target) return;
  const button = $("#undoButton");
  button.disabled = true;
  try {
    const restored = await restoreLocal(target.name, target.id, target.version);
    if (undoTarget === target) clearUndo();
    if (restored) await render();
  } catch (error) {
    console.error("Unable to restore locally", error);
    if (undoTarget === target) {
      $("#undoMessage").textContent = "恢复失败，请重试";
      clearTimeout(undoTimer);
      undoTimer = setTimeout(clearUndo, 6000);
    }
  } finally {
    button.disabled = false;
  }
};

function setCaptureMode(mode) {
  captureMode = mode;
  $$(".capture-mode").forEach(button => {
    const active = button.dataset.captureMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const input = $("#captureInput");
  const submit = $("#captureForm button[type='submit']");
  const label = mode === "task" ? "添加任务" : "添加记录";
  $("#captureInputLabel").textContent = mode === "task" ? "快速添加任务" : "快速记录";
  input.placeholder = mode === "task" ? "接下来要完成什么？" : "写下此刻在想的…";
  submit.setAttribute("aria-label", label);
  submit.title = label;
  $("#captureHint").textContent = mode === "task" ? "回车保存为任务" : "回车保存";
  $("#captureStatus").textContent = "";
  input.focus();
}

$$(".capture-mode").forEach(button => { button.onclick = () => setCaptureMode(button.dataset.captureMode); });
$("#captureInput").oninput = () => { $("#captureStatus").textContent = ""; };

const pendingForms = new WeakSet();

async function submitOnce(form, status, save) {
  if (pendingForms.has(form)) return;
  pendingForms.add(form);
  const buttons = $$('button:not([value="cancel"])', form);
  buttons.forEach(button => { button.disabled = true; });
  status.textContent = "";
  try {
    await save();
  } catch (error) {
    console.error("Unable to save locally", error);
    status.textContent = "保存失败，输入内容已保留，请重试。";
  } finally {
    pendingForms.delete(form);
    buttons.forEach(button => { button.disabled = false; });
  }
}

$("#captureForm").onsubmit = async event => {
  event.preventDefault();
  const input = $("#captureInput");
  const draft = input.value;
  const raw = draft.trim();
  if (!raw) return;
  const hasTaskCommand = /^\/task(\s|$)/i.test(raw);
  const isTask = captureMode === "task" || hasTaskCommand;
  const text = hasTaskCommand ? raw.replace(/^\/task\s*/i, "").trim() : raw;
  if (!text) return;
  await submitOnce($("#captureForm"), $("#captureStatus"), async () => {
    if (isTask) await createLocal("tasks", { text, done: false });
    else await createLocal("notes", { text });
    if (input.value === draft) input.value = "";
    await render();
    $("#captureStatus").textContent = isTask ? "任务已添加" : "记录已保存";
  });
};

$("#taskForm").onsubmit = async event => {
  event.preventDefault();
  const input = $("#taskInput");
  const draft = input.value;
  const text = draft.trim();
  if (!text) return;
  await submitOnce($("#taskForm"), $("#taskStatus"), async () => {
    await createLocal("tasks", { text, done: false });
    if (input.value === draft) input.value = "";
    await render();
    $("#taskStatus").textContent = "任务已添加";
  });
};

$$(".chip").forEach(chip => {
  chip.onclick = () => {
    filter = chip.dataset.filter;
    $$(".chip").forEach(element => {
      const active = element === chip;
      element.classList.toggle("active", active);
      element.setAttribute("aria-pressed", String(active));
    });
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
  const draft = $("#editorText").value;
  const text = draft.trim();
  if (!text) return;
  const revision = editorRevision;
  const id = editing;
  await submitOnce($("#editorForm"), $("#editorStatus"), async () => {
    const saved = id ? await updateLocal("notes", id, { text }) : await createLocal("notes", { text });
    if (revision === editorRevision && $("#editorDialog").open) {
      if (!saved) {
        $("#editorStatus").textContent = "这条记录已被删除，草稿仍保留，可复制后新建记录。";
        return;
      }
      editing = saved.id;
      if ($("#editorText").value === draft) {
        $("#editorDialog").close();
        editing = null;
      }
    }
    await render();
  });
};

$("#themeToggle").onchange = event => {
  const nextTheme = event.target.checked ? "dark" : "light";
  applyTheme(nextTheme);
  try { localStorage.setItem("test1-theme", nextTheme); } catch { /* Keep the theme for this session. */ }
};

$("#exportButton").onclick = exportBackup;
$("#importButton").onclick = () => $("#importFile").click();
$("#importFile").onchange = event => importBackup(event.target.files?.[0]);

renderDate();
// Keep the masthead and margin stamps current when the app is reopened on a later day.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  renderDate();
  render().catch(console.error);
});

theme();
icons();
window.addEventListener("workspace:remote-change", () => render().catch(console.error));
const ready = seed().then(render);
ready.catch(error => {
  console.error("Unable to initialize local storage", error);
  $("#captureStatus").textContent = "无法打开本地数据，请检查浏览器存储权限后重试。";
});

export { db, ready };
