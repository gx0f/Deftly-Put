// Exercise the MV3 worker's install, popup and translation entry points offline.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const extension = path.resolve(__dirname, '../../Deftly-Put/extension');

function startWorker(storage, locale) {
  const listeners = [];
  let installed;
  let lastRequest;
  const runtime = {
    id: 'test-extension',
    getURL: file => 'chrome-extension://test-extension/' + file,
    onMessage: {addListener: listener => listeners.push(listener)},
    onInstalled: {addListener: listener => { installed = listener; }},
    connectNative() {
      let respond;
      return {
        onMessage: {addListener: listener => { respond = listener; }},
        onDisconnect: {addListener() {}},
        postMessage(payload) {
          lastRequest = payload;
          respond({ok: true, sourceLanguage: 'und', text: 'Translation'});
        },
        disconnect() {}
      };
    }
  };
  const chrome = {runtime, tabs: {query: async () => []}, i18n: {getUILanguage: () => locale},
    storage: {local: {
      get: async key => ({[key]: storage[key]}),
      set: async update => { Object.assign(storage, update); }
    }}};
  function load(file) {
    vm.runInContext(fs.readFileSync(path.join(extension, file), 'utf8'), context, {filename: file});
  }
  const context = vm.createContext({chrome, importScripts: load, URL});
  load('background.js');
  function send(request, url = runtime.getURL('popup.html')) {
    return new Promise((resolve, reject) => {
      const sender = {id: runtime.id, url, tab: {windowId: 1}};
      if (!listeners.some(listener => listener(request, sender, resolve))) reject(Error('Unhandled ' + request.action));
    });
  }
  async function translate(target, source) {
    const result = await send({action: 'translate', draft: 'A draft', post: target === 'auto' ? 'A post' : '',
      tone: 'natural', langHint: '', target, source}, 'https://x.com/home');
    assert.equal(result.ok, true);
    return [lastRequest.target, lastRequest.source, result.sourceLanguage];
  }
  return {installed, send, translate};
}

test('install captures the browser UI language and upgrades preserve both choices', async () => {
  const storage = {};
  const first = startWorker(storage, 'zh-TW');
  await first.installed({reason: 'install'});
  const next = startWorker(storage, 'de');
  await next.installed({reason: 'update'});
  assert.deepEqual(await next.translate('default'), ['en', 'zh-TW', 'zh-TW']);

  const update = {action: 'setLanguageSettings', source: 'pt-br', target: 'ja'};
  assert.equal((await next.send(update)).ok, true);
  assert.equal((await next.send({...update, source: 'und'})).ok, false);
  const again = startWorker(storage, 'fr');
  const prefs = await again.send({action: 'getLanguageSettings'});
  assert.deepEqual([prefs.source, prefs.target], ['pt-BR', 'ja']);
  assert.deepEqual(await again.translate('default'), ['ja', 'pt-BR', 'pt-BR']);
  assert.deepEqual(await again.translate('auto'), ['auto', 'pt-BR', 'pt-BR']);
  assert.deepEqual(await again.translate('ko'), ['ko', 'pt-BR', 'pt-BR']);
  assert.deepEqual(await again.translate('es', 'zh-Hant'), ['es', 'zh-Hant', 'zh-Hant']);
});

test('installing defaults and saving from the popup can overlap', async () => {
  const worker = startWorker({}, 'de');
  await Promise.all([
    worker.installed({reason: 'update'}),
    worker.send({action: 'setLanguageSettings', source: 'fr', target: 'it'})
  ]);
  assert.deepEqual(await worker.translate('default'), ['it', 'fr', 'fr']);
});
