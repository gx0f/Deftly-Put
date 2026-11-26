"use strict";

const languageSettings = (() => {
  const key = "languageSettings";
  let pending = Promise.resolve();

  function normalize(value) {
    if (typeof value !== "string") return "";
    const tag = value.trim();
    if (tag.length > 35 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,4}$/i.test(tag) ||
        /^(?:und|mul|zxx)(?:-|$)/i.test(tag)) return "";
    try { return Intl.getCanonicalLocales(tag)[0]; } catch { return ""; }
  }

  // Installation, popup saves and translations can all wake the same worker.
  // Serialize changes so that a delayed first read never overwrites a user choice.
  function enqueue(task) {
    const result = pending.then(task);
    pending = result.catch(() => {});
    return result;
  }

  function get() {
    return enqueue(async () => {
      const stored = (await chrome.storage.local.get(key))[key];
      const source = normalize(stored?.source) || normalize(chrome.i18n.getUILanguage()) || "en";
      const target = normalize(stored?.target) || "en";
      if (source !== stored?.source || target !== stored?.target) {
        await chrome.storage.local.set({[key]: {source, target}});
      }
      return {source, target};
    });
  }

  function save(request) {
    return enqueue(async () => {
      const source = normalize(request.source);
      const target = normalize(request.target);
      if (!source || !target) throw new Error("请输入有效的语言代码，例如 nl 或 pt-BR。");
      await chrome.storage.local.set({[key]: {source, target}});
      return {source, target};
    });
  }

  if (typeof document === "undefined") {
    const popup = chrome.runtime.getURL("popup.html");
    chrome.runtime.onMessage.addListener((request, sender, reply) => {
      if (!request || sender.id !== chrome.runtime.id) return false;
      const fromPopup = sender.url === popup;
      let response;
      if (request.action === "getLanguageSettings" && (fromPopup || /^https:\/\/(x\.com|twitter\.com)\//.test(sender.url || ""))) {
        response = get();
      } else if (request.action === "setLanguageSettings" && fromPopup) {
        response = save(request);
      } else {
        return false;
      }
      response.then(settings => reply({ok:true, ...settings}), err => reply({ok:false, error:err.message}));
      return true;
    });
  }

  return {get, normalize};
})();
