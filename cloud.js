import { createClient } from "@supabase/supabase-js";
import { db, ready } from "./app.js";

const SUPABASE_URL = "https://oydhkcghcfxwvyfclwgy.supabase.co";
const SUPABASE_KEY = "sb_publishable_zhGDgWLzFX4_2HMLwgWn9w_nHIKmZuI";
const AUTH_REDIRECT_URL = "https://today-workspace.vercel.app";
const BOUND_USER_KEY = "today-workspace-bound-user";
const LAST_SYNC_KEY = "today-workspace-last-sync-at";
const SEED_NOTE = "这是一个本地优先的移动工作台。打开即记录，不要求先整理。";
const SEED_TASK = "试着完成一个任务，再新增一条记录";

const recoveryParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
let recoveryMode = recoveryParams.get("type") === "recovery";
let activeSession = null;
let sessionRevision = 0;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = selector => document.querySelector(selector);

async function getAll(storeName) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName).objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function countPending() {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("outbox").objectStore("outbox").count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Sync transaction aborted"));
  });
}

function isNewer(candidate, existing) {
  if (!existing) return true;
  if (candidate.updatedAt !== existing.updatedAt) return candidate.updatedAt > existing.updatedAt;
  return (candidate.version || 1) > (existing.version || 1);
}

function toRemote(record) {
  return {
    id: record.id,
    text: record.text,
    ...(typeof record.done === "boolean" ? { done: record.done } : {}),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    version: record.version || 1,
    deleted_at: record.deletedAt || null,
    device_id: record.deviceId || "unknown"
  };
}

function sameRecord(left, right) {
  return Boolean(left && right) && JSON.stringify(toRemote(left)) === JSON.stringify(toRemote(right));
}

function fromRemote(row, userId) {
  return {
    id: row.id,
    text: row.text,
    ...(typeof row.done === "boolean" ? { done: row.done } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    version: Number(row.version || 1),
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
    deviceId: row.device_id,
    userId,
    syncStatus: "synced"
  };
}

function setStatus(message) {
  const element = $("#cloudStatus");
  if (element) element.textContent = message;
}

function formatSyncTime(timestamp) {
  if (!timestamp) return "尚未同步";
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat("zh-CN", sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }
  ).format(date);
}

let metaRevision = 0;
async function refreshSyncMeta(session = activeSession) {
  const revision = ++metaRevision;
  const element = $("#cloudSyncMeta");
  if (!element) return;
  try {
    const pending = await countPending();
    if (revision !== metaRevision) return;
    if (!session?.user) {
      element.textContent = pending ? `本地模式 · 待同步 ${pending} 项` : "本地模式 · 当前无待同步修改";
      return;
    }
    const lastSync = Number(localStorage.getItem(LAST_SYNC_KEY) || 0);
    const pendingText = pending ? `待同步 ${pending} 项` : "已同步";
    element.textContent = `${pendingText} · ${lastSync ? `上次 ${formatSyncTime(lastSync)}` : "尚未完成首次同步"}`;
  } catch (error) {
    console.warn("Unable to read sync metadata", error);
  }
}

function ensureAccountUi() {
  if ($("#cloudAccount")) return;
  const settings = $(".settings");
  if (!settings) return;
  const section = document.createElement("div");
  section.className = "setting setting-stack";
  section.id = "cloudAccount";
  section.innerHTML = `
    <span><strong>账号与同步</strong><small id="cloudIdentity">未登录时仍可完全本地使用</small></span>
    <form class="cloud-login" id="cloudLoginForm">
      <input id="cloudEmail" type="email" autocomplete="email" placeholder="邮箱" required />
      <input id="cloudPassword" type="password" autocomplete="current-password" minlength="6" placeholder="密码（至少 6 位）" required />
      <div class="data-actions">
        <button class="btn compact primary" type="submit">登录</button>
        <button class="btn compact" type="button" id="cloudSignupButton">注册</button>
        <button class="btn compact" type="button" id="cloudResetButton">忘记密码</button>
      </div>
    </form>
    <form class="cloud-login" id="cloudRecoveryForm" hidden>
      <input id="cloudNewPassword" type="password" autocomplete="new-password" minlength="6" placeholder="输入新密码（至少 6 位）" required />
      <div class="data-actions">
        <button class="btn compact primary" type="submit">保存新密码</button>
      </div>
    </form>
    <div class="data-actions" id="cloudSignedInActions" hidden>
      <button class="btn compact" type="button" id="cloudSyncButton">立即同步</button>
      <button class="btn compact" type="button" id="cloudLogoutButton">退出登录</button>
    </div>
    <p class="backup-status cloud-sync-meta" id="cloudSyncMeta" aria-live="polite"></p>
    <p class="backup-status" id="cloudStatus" aria-live="polite"></p>`;
  settings.prepend(section);

  $("#cloudLoginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const email = $("#cloudEmail").value.trim();
    const password = $("#cloudPassword").value;
    setStatus("正在登录…");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setStatus(error.message);
  });

  $("#cloudSignupButton").addEventListener("click", async () => {
    const email = $("#cloudEmail").value.trim();
    const password = $("#cloudPassword").value;
    if (!email || password.length < 6) {
      setStatus("请输入有效邮箱和至少 6 位密码。");
      return;
    }
    setStatus("正在注册…");
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: AUTH_REDIRECT_URL }
    });
    if (error) setStatus(error.message);
    else if (!data.session) setStatus("注册成功，请先到邮箱确认账号，再回来登录。");
  });

  $("#cloudResetButton").addEventListener("click", async () => {
    const email = $("#cloudEmail").value.trim();
    if (!email) {
      setStatus("请先输入需要找回的邮箱。");
      return;
    }
    setStatus("正在发送重置邮件…");
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: AUTH_REDIRECT_URL });
    setStatus(error ? error.message : "重置邮件已发送，请打开邮件中的链接设置新密码。");
  });

  $("#cloudRecoveryForm").addEventListener("submit", async event => {
    event.preventDefault();
    const password = $("#cloudNewPassword").value;
    if (password.length < 6) {
      setStatus("新密码至少需要 6 位。");
      return;
    }
    setStatus("正在更新密码…");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setStatus(error.message);
      return;
    }
    recoveryMode = false;
    $("#cloudNewPassword").value = "";
    renderSession(activeSession);
    setStatus("密码已更新，可以继续使用当前账号。");
  });

  $("#cloudSyncButton").addEventListener("click", () => syncNow());
  $("#cloudLogoutButton").addEventListener("click", () => supabase.auth.signOut());
}

function renderRecoveryMode(active) {
  recoveryMode = active;
  const form = $("#cloudRecoveryForm");
  if (!form) return;
  form.hidden = !active;
  if (active) {
    $("#cloudLoginForm").hidden = true;
    $("#cloudSignedInActions").hidden = true;
    $("#cloudIdentity").textContent = "正在恢复账号，请设置新密码";
    setTimeout(() => $("#cloudNewPassword")?.focus(), 50);
  } else {
    renderSession(activeSession);
  }
}

function renderSession(session) {
  ensureAccountUi();
  activeSession = session;
  const loggedIn = Boolean(session?.user);
  $("#cloudLoginForm").hidden = loggedIn || recoveryMode;
  $("#cloudRecoveryForm").hidden = !recoveryMode;
  $("#cloudSignedInActions").hidden = !loggedIn || recoveryMode;
  $("#cloudIdentity").textContent = recoveryMode
    ? "正在恢复账号，请设置新密码"
    : loggedIn
      ? session.user.email || "已登录"
      : "未登录时仍可完全本地使用";
  if (!loggedIn && !recoveryMode) setStatus("");
  refreshSyncMeta(session);
}

function untouchedSeed(record, text) {
  return record && record.text === text && (record.version || 1) === 1 && !record.deletedAt && record.userId == null && record.syncStatus !== "synced";
}

async function discardUntouchedSeedExamples() {
  const database = await db();
  const transaction = database.transaction(["notes", "tasks", "outbox"], "readwrite");
  const completed = transactionDone(transaction);
  let removed = 0;
  for (const [storeName, text] of [["notes", SEED_NOTE], ["tasks", SEED_TASK]]) {
    const request = transaction.objectStore(storeName).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (untouchedSeed(cursor.value, text)) {
        cursor.delete();
        transaction.objectStore("outbox").delete(`${storeName}:${cursor.value.id}`);
        removed++;
      }
      cursor.continue();
    };
  }
  await completed;
  if (removed) window.dispatchEvent(new Event("workspace:remote-change"));
}

async function ensureUserBinding(userId) {
  const bound = localStorage.getItem(BOUND_USER_KEY);
  if (!bound) {
    await discardUntouchedSeedExamples();
    localStorage.setItem(BOUND_USER_KEY, userId);
    return true;
  }
  return bound === userId;
}

async function acknowledgeEntry(entry, userId) {
  const database = await db();
  const transaction = database.transaction([entry.store, "outbox"], "readwrite");
  const completed = transactionDone(transaction);
  const outbox = transaction.objectStore("outbox");
  const queued = outbox.get(entry.id);
  queued.onsuccess = () => {
    // The upload acknowledged this snapshot only. A newer local edit must stay queued.
    if (!sameRecord(queued.result?.record, entry.record)) return;
    outbox.delete(entry.id);
    const store = transaction.objectStore(entry.store);
    const current = store.get(entry.entityId);
    current.onsuccess = () => {
      if (sameRecord(current.result, entry.record)) {
        store.put({ ...current.result, userId, syncStatus: "synced" });
      }
    };
  };
  await completed;
}

async function pushOutbox(userId, assertCurrent = () => {}) {
  const entries = await getAll("outbox");
  let pushed = 0;
  for (const entry of entries) {
    assertCurrent();
    const fn = entry.store === "notes" ? "sync_upsert_note" : "sync_upsert_task";
    const { error } = await supabase.rpc(fn, { payload: toRemote(entry.record) });
    if (error) throw error;
    assertCurrent();
    await acknowledgeEntry(entry, userId);
    pushed++;
  }
  return pushed;
}

async function mergeRemotePage(storeName, rows, userId) {
  const database = await db();
  const transaction = database.transaction([storeName, "outbox"], "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(storeName);
  const outbox = transaction.objectStore("outbox");
  let changed = 0;
  for (const row of rows) {
    const incoming = fromRemote(row, userId);
    const currentRequest = store.get(incoming.id);
    const pendingRequest = outbox.get(`${storeName}:${incoming.id}`);
    pendingRequest.onsuccess = () => {
      // Unsent changes may have arrived while the network request was in flight.
      if (pendingRequest.result) return;
      const current = currentRequest.result;
      if (isNewer(incoming, current)) {
        store.put(incoming);
        changed++;
      } else if (sameRecord(current, incoming) && current.syncStatus !== "synced") {
        store.put({ ...current, userId, syncStatus: "synced" });
      }
    };
  }
  await completed;
  if (changed) window.dispatchEvent(new Event("workspace:remote-change"));
  return changed;
}

async function pullStore(storeName, userId, assertCurrent = () => {}) {
  let changed = 0;
  let lastId = null;
  // Keyset pagination also handles projects whose API row cap is below our page size.
  while (true) {
    assertCurrent();
    let query = supabase.from(storeName).select("*").order("id").limit(500);
    if (lastId !== null) query = query.gt("id", lastId);
    const { data, error } = await query;
    if (error) throw error;
    assertCurrent();
    if (!data?.length) break;
    changed += await mergeRemotePage(storeName, data, userId);
    lastId = data[data.length - 1].id;
  }
  return changed;
}

let syncPromise = null;
let syncTimer;
let syncRequested = false;

function scheduleSync() {
  clearTimeout(syncTimer);
  if (syncPromise) {
    syncRequested = true;
    return;
  }
  syncTimer = setTimeout(() => syncNow(), 300);
}

function syncNow() {
  if (syncPromise) return syncPromise;
  clearTimeout(syncTimer);
  // Reserve the flight before session lookup and account binding can yield.
  syncPromise = performSync().finally(() => {
    syncPromise = null;
    if (syncRequested) {
      syncRequested = false;
      scheduleSync();
    }
  });
  return syncPromise;
}

async function performSync() {
  try {
    await ready;
    if (!navigator.onLine) {
      setStatus("当前离线，本地修改会保留，联网后自动同步。");
      return;
    }
    const authRevision = sessionRevision;
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (authRevision !== sessionRevision) return;
    const session = data.session;
    activeSession = session;
    if (!session?.user) return;
    if (!await ensureUserBinding(session.user.id)) {
      setStatus("此设备的本地数据已绑定另一个账号，已暂停同步以避免数据混用。");
      return;
    }
    const userId = session.user.id;
    const assertCurrent = () => {
      if (authRevision !== sessionRevision || activeSession?.user?.id !== userId) {
        throw Object.assign(new Error("Account changed during sync"), { code: "ACCOUNT_CHANGED" });
      }
    };
    assertCurrent();
    setStatus("正在同步…");
    await refreshSyncMeta(session);
    const pushed = await pushOutbox(userId, assertCurrent);
    // Wait for both pulls to settle before releasing the flight if one fails.
    const results = await Promise.allSettled([
      pullStore("notes", userId, assertCurrent),
      pullStore("tasks", userId, assertCurrent)
    ]);
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    assertCurrent();
    const changed = results.reduce((sum, result) => sum + result.value, 0);
    try { localStorage.setItem(LAST_SYNC_KEY, String(Date.now())); } catch { /* The sync itself succeeded. */ }
    setStatus(`同步完成${pushed ? ` · 上传 ${pushed}` : ""}${changed ? ` · 更新 ${changed}` : ""}`);
  } catch (error) {
    if (error.code !== "ACCOUNT_CHANGED") {
      console.error("Cloud sync failed", error);
      setStatus("同步失败，本地数据不受影响；稍后可重试。");
    }
  } finally {
    await refreshSyncMeta(activeSession);
  }
}

ensureAccountUi();

supabase.auth.onAuthStateChange((event, nextSession) => {
  if (activeSession?.user?.id !== nextSession?.user?.id) sessionRevision++;
  activeSession = nextSession;
  renderSession(nextSession);
  if (event === "PASSWORD_RECOVERY") {
    renderRecoveryMode(true);
    setStatus("请设置一个新密码完成账号恢复。");
    return;
  }
  if (event === "SIGNED_IN" && nextSession?.user && !recoveryMode) scheduleSync();
});

try {
  await ready;
  const authRevision = sessionRevision;
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (authRevision === sessionRevision) renderSession(session);
  if (recoveryMode) renderRecoveryMode(true);
  else if (activeSession?.user) syncNow();
} catch (error) {
  console.error("Unable to initialize cloud session", error);
  renderSession(null);
  setStatus("暂时无法连接账号服务，仍可继续本地使用。");
}

window.addEventListener("online", () => syncNow());
window.addEventListener("workspace:local-change", () => {
  refreshSyncMeta();
  if (!recoveryMode) scheduleSync();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshSyncMeta();
    syncNow();
  }
});
