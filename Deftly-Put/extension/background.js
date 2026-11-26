"use strict";

importScripts("language-settings.js");

const maxAncestors = 3;

const NATIVE_HOST = "app.xreply.translator";
const POPUP = chrome.runtime.getURL("popup.html");
const accountActions = new Set(["status", "login", "switchAccount", "logout"]);
let activeLogin = null;

// Session storage is extension-private. A restored or duplicated X tab has its
// own tab ID, while a reload in the same tab keeps its last generated signature.
const replyKeys = tab => ["x.com", "twitter.com"].map(host => `writtenReply:${tab}:${host}`);
let replyUpdates = Promise.resolve();
function queueReplyUpdate(task) {
  const result = replyUpdates.then(task);
  replyUpdates = result.catch(() => {});
  return result;
}
chrome.tabs.onRemoved?.addListener(tab => {
  void queueReplyUpdate(() => chrome.storage.session.remove(replyKeys(tab)));
});
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.action !== "writtenReply" || sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) ||
      sender.frameId !== 0 || !/^https:\/\/(x\.com|twitter\.com)\//.test(sender.url || "")) return false;
  const key = `writtenReply:${sender.tab.id}:${new URL(sender.url).hostname}`;
  const store = chrome.storage.session;
  queueReplyUpdate(async () => {
    if (msg.operation === "remember") {
      const {token, digest, length, id, author, timestamp} = msg.record;
      if (!/^[\da-f-]{36}$/.test(token) || !/^[\da-f]{64}$/.test(digest) || !Number.isInteger(length) ||
          length < 1 || length > 130000 || !/^\d{0,20}$/.test(id) || !/^(?:@[\w]{1,15})?$/.test(author) ||
          !/^(?:[\dTZ:.+-]{10,32})?$/.test(timestamp) || (!id && !author)) return null;
      const record = {token, digest, length, id, author, timestamp};
      await store.set({[key]:record});
      return record;
    }
    const record = (await store.get(key))[key];
    if (record && msg.operation === "forget" && msg.token === record.token) {
      await store.remove(key);
      return null;
    }
    return msg.operation === "read" ? record || null : null;
  }).then(record => reply({record}), () => reply({record:null}));
  return true;
});

function statusPage(url, id) {
  if (!url) return false;
  try {
    const link = new URL(url);
    return ["https://x.com", "https://twitter.com"].includes(link.origin) &&
      link.pathname.match(/^\/(?:i\/web|[\w]+)\/status\/(\d+)\/?$/)?.[1] === id;
  } catch { return false; }
}

async function translateWithContext(payload, id, senderTab) {
  const defaults = await languageSettings.get();
  payload.source = languageSettings.normalize(payload.source) || defaults.source;
  if (payload.target === "default") payload.target = defaults.target;
  if (typeof id === "string" && /^\d{1,20}$/.test(id) && (payload.ancestors?.length || 0) < maxAncestors) {
    // The native helper can read the public post in the background. Reuse a
    // better already-loaded conversation first, including signed-in context.
    payload.lookupStatusId = id;
    try {
      const tabs = await chrome.tabs.query({windowId:senderTab.windowId, url:["https://x.com/*/status/*", "https://twitter.com/*/status/*"]});
      const tab = tabs.find(item => !item.discarded && statusPage(item.url, id));
      if (tab?.id != null) {
        const result = await chrome.tabs.sendMessage(tab.id, {action:"readAncestors", statusId:id}, {frameId:0});
        if (result?.ready && Array.isArray(result.ancestors)) {
          const visible = result.ancestors.slice(-maxAncestors);
          if (visible.length > (payload.ancestors?.length || 0)) payload.ancestors = visible;
          if (result.complete || visible.length === maxAncestors) delete payload.lookupStatusId;
        }
      }
    } catch { /* A tab may close or navigate while the request is in flight. */ }
  }
  const result = await callHelper(payload);
  // An older installed helper may still report the language it inferred from the draft.
  return result.ok ? {...result, sourceLanguage:payload.source} : result;
}

// Unpacked updates also need to reach replies which already contain an unsent draft.
chrome.runtime.onInstalled.addListener(async ({reason}) => {
  await languageSettings.get();
  if (reason !== "update") return;
  const tabs = await chrome.tabs.query({url: ["https://x.com/*", "https://twitter.com/*"]});
  await Promise.allSettled(tabs.filter(tab => tab.id != null && !tab.discarded).map(tab =>
    chrome.scripting.executeScript({target: {tabId: tab.id}, files: ["content.js"]})
  ));
});

function nativeFailure(message) {
  if (/host not found|not allowed|forbidden|native messaging host wasn't found/i.test(message)) {
    return "未连接到本机助手。请先运行随附的安装程序，再从 Chrome 工具栏打开「Deftly Put」。";
  }
  return "无法连接本机助手。请检查助手是否已安装，然后重试。";
}

// A native port keeps the MV3 worker running while OpenAI's login tab is in front
// or while a translation is still streaming. The helper answers one request per port.
function callHelper(payload) {
  return new Promise(resolve => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
      port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        resolve({ok: false, error: nativeFailure(error?.message || "")});
      });
      port.onMessage.addListener(result => {
        resolve(result || {ok: false, error: "本机助手没有返回结果。"});
        port.disconnect();
      });
      port.postMessage(payload);
    } catch (err) {
      if (port) port.disconnect();
      resolve({ok: false, error: nativeFailure(err.message)});
    }
  });
}

chrome.runtime.onMessage.addListener((request, sender, reply) => {
  if (!request || sender.id !== chrome.runtime.id) return false;
  let payload;
  if (accountActions.has(request.action) && sender.url === POPUP) {
    if ((request.action === "status" || request.action === "login" || request.action === "switchAccount") && activeLogin) {
      activeLogin.then(reply);
      return true;
    }
    payload = {action: request.action};
  } else if (!/^https:\/\/(x\.com|twitter\.com)\//.test(sender.url || "")) {
    return false;
  } else if (request.action === "detectEditLanguage") {
    if (typeof request.text !== "string" || request.text.length > 4096) {
      reply({ok:false, language:""});
      return false;
    }
    payload = {action:"detectEditLanguage", text:request.text};
  } else if (request.action === "backTranslate") {
    const {text, target} = request;
    if (typeof text !== "string" || typeof target !== "string") {
      reply({ok:false, error:"回译数据不完整。"});
      return false;
    }
    payload = {action:"backTranslate", text, target};
  } else if (request.action === "translate") {
    const {draft, post, langHint, target, tone} = request;
    if (![draft, post, langHint, target, tone].every(value => typeof value === "string")) {
      reply({ok: false, error: "回复草稿的数据不完整，请重试。"});
      return false;
    }
    payload = {action: "translate", draft, post, langHint, target, tone, source:request.source};
    if (Array.isArray(request.ancestors) && request.ancestors.length) payload.ancestors = request.ancestors.slice(-maxAncestors);
    if (request.quotedPost) payload.quotedPost = request.quotedPost;
  } else {
    return false;
  }
  const result = payload.action === "translate" ? translateWithContext(payload, request.lookupStatusId, sender.tab) : callHelper(payload);
  if (payload.action === "login" || payload.action === "switchAccount") {
    activeLogin = result;
    result.finally(() => { activeLogin = null; });
  }
  result.then(reply, () => reply({ok:false, error:"未能读取插件设置或完成请求，请重试。"}));
  return true;
});
