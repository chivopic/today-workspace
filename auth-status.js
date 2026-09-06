const STATUS_MESSAGES = [
  [/email rate limit exceeded/i, "邮件发送过于频繁，请稍后再试。"],
  [/invalid login credentials/i, "邮箱或密码不正确。"],
  [/email not confirmed/i, "邮箱尚未确认，请先查看确认邮件。"],
  [/user already registered/i, "该邮箱已注册，请直接登录。"]
];

function localizeStatus(element) {
  const message = element?.textContent?.trim();
  if (!message) return;
  for (const [pattern, localized] of STATUS_MESSAGES) {
    if (pattern.test(message)) {
      element.textContent = localized;
      return;
    }
  }
}

function attachStatusLocalization() {
  const status = document.querySelector("#cloudStatus");
  if (!status) return;
  localizeStatus(status);
  const observer = new MutationObserver(() => localizeStatus(status));
  observer.observe(status, { childList: true, characterData: true, subtree: true });
}

queueMicrotask(attachStatusLocalization);
