const dialog = document.querySelector("#settingsDialog");
const form = document.querySelector("#cloudRecoveryForm");
const account = document.querySelector("#cloudAccount");
const title = dialog?.querySelector(".sheet-head h2");

function syncRecoveryDialog() {
  if (!dialog || !form) return;
  if (!form.hidden) {
    if (title) title.textContent = "重置密码";
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => account?.scrollIntoView({ block: "start" }));
    return;
  }
  if (title) title.textContent = "设置";
}

syncRecoveryDialog();

if (form) {
  new MutationObserver(syncRecoveryDialog).observe(form, {
    attributes: true,
    attributeFilter: ["hidden"]
  });
}
