"use strict";

const state = document.getElementById("state");
const account = document.getElementById("account");
const switcher = document.getElementById("switch");
let nextAction = "status";

const languageForm = document.getElementById("languages");
const fields = languageForm.querySelector("fieldset");
const languageStatus = document.getElementById("language-status");
const languageFields = ["source", "target"].map(key => ({
  key,
  select: document.getElementById(key),
  code: document.getElementById(key + "-code")
}));

async function loadLanguageSettings() {
  try {
    const result = await chrome.runtime.sendMessage({action:"getLanguageSettings"});
    if (!result?.ok) throw new Error(result?.error || "无法读取语言设置，请重新打开弹窗。");
    const common = ["zh-Hans", "zh-Hant", "en", "ja", "ko", "es", "fr", "de", "pt", "it", "ru", "ar", "hi"];
    const tags = new Set([...common, languageSettings.normalize(chrome.i18n.getUILanguage()), result.source, result.target]);
    const names = new Intl.DisplayNames(["zh-CN"], {type:"language"});
    for (const {key, select, code} of languageFields) {
      for (const tag of tags) {
        if (tag) select.add(new Option(names.of(tag), tag));
      }
      select.add(new Option("其他语言…", "custom"));
      select.value = result[key];
      code.disabled = true;
      select.addEventListener("change", () => {
        code.disabled = code.hidden = select.value !== "custom";
        code.setCustomValidity("");
        if (!code.hidden) code.focus();
        languageStatus.textContent = "";
      });
      code.addEventListener("input", () => {
        code.setCustomValidity("");
        languageStatus.textContent = "";
      });
    }
    fields.disabled = false;
  } catch (err) {
    languageStatus.textContent = err.message;
  }
}

languageForm.addEventListener("submit", async event => {
  event.preventDefault();
  const request = {action:"setLanguageSettings"};
  for (const {key, select, code} of languageFields) {
    request[key] = select.value === "custom" ? languageSettings.normalize(code.value) : select.value;
    if (!request[key]) {
      code.setCustomValidity("请输入有效的语言代码，例如 nl 或 pt-BR。");
      code.reportValidity();
      return;
    }
  }
  fields.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage(request);
    if (!result?.ok) throw new Error(result?.error || "未能保存语言设置，请重试。");
    languageStatus.textContent = "语言设置已保存。";
  } catch (err) {
    languageStatus.textContent = err.message;
  } finally {
    fields.disabled = false;
  }
});

async function run(action) {
  account.disabled = switcher.disabled = true;
  if (action === "login" || action === "switchAccount") state.textContent = "请在打开的 OpenAI 页面登录，并授权本工具使用你的 ChatGPT 套餐。";
  if (action === "logout") state.textContent = "正在退出本机账号…";
  try {
    const result = await chrome.runtime.sendMessage({action});
    if (!result?.ok) throw new Error(result?.error || "无法连接本机助手。");
    const connected = result.connected ?? result.signedIn;
    const label = result.account ? " · " + result.account : "";
    if (connected) {
      state.textContent = "已连接 ChatGPT 套餐" + label;
    } else if (result.signedIn) {
      state.textContent = "已登录" + label + "。请继续授权使用 ChatGPT 套餐额度。";
    } else {
      state.textContent = "登录并授权后，Deftly Put 会使用你的 ChatGPT 套餐额度生成回复。";
    }
    if (action === "logout" && result.revoked === false) state.textContent = "已退出本机账号。可在 ChatGPT 设置的应用连接中检查或撤销授权。";
    nextAction = connected ? "logout" : "login";
    account.textContent = connected ? "退出本机账号" : "Continue with ChatGPT";
    switcher.hidden = !result.signedIn;
  } catch (err) {
    state.textContent = err.message;
    nextAction = "status";
    account.textContent = "重新检查";
    switcher.hidden = true;
  } finally {
    account.hidden = false;
    account.disabled = switcher.disabled = false;
  }
}

account.addEventListener("click", () => run(nextAction));
switcher.addEventListener("click", () => run("switchAccount"));
async function start() {
  const {name, version: activeVersion} = chrome.runtime.getManifest();
  document.querySelector("h1").textContent = name + " · " + activeVersion;
  // Chrome caches registered content scripts but serves an unpacked popup from disk.
  // Reload this extension on a local version change without reloading any X tabs.
  try {
    const response = await fetch(chrome.runtime.getURL("manifest.json"), {cache: "no-store"});
    const installedFiles = await response.json();
    if (installedFiles.version !== activeVersion) {
      state.textContent = "正在启用新版本…";
      chrome.runtime.reload();
      return;
    }
  } catch { /* Account controls are still useful if the local manifest is unavailable. */ }
  // A tab restored from Chrome's back/forward cache can still contain the old widget.
  // Reattach to the current X page without navigating or replacing an unsent draft.
  const status = run("status");
  const languages = loadLanguageSettings();
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true, url: ["https://x.com/*", "https://twitter.com/*"]});
    if (tab?.id != null && !tab.discarded) {
      await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ["content.js"]});
    }
  } catch { /* The tab may have navigated or closed while the popup opened. */ }
  await Promise.all([status, languages]);
}
start();
