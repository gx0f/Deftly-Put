// Offline regression for an X-style controlled Draft.js editor whose selection lags behind Chrome.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fixtureScript} = require('../draft-qa/resources.cjs');
const {chromium} = require('playwright-core');

const project = process.env.XREPLY_QA_ROOT || path.resolve(__dirname, '../..');
const extension = process.env.XREPLY_EXTENSION_DIR || path.join(project, 'Deftly-Put/extension');
const fixtures = path.join(project, 'work/draft-qa');
const html = fs.readFileSync(path.join(fixtures, 'fixture.html'), 'utf8');
const scripts = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'))).content_scripts.flatMap(s => s.js);
const chineseCheck = '那是一盏蓝灯。';

async function runCase(browser, original, translation, mode) {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://x.com') return route.abort();
      if (url.pathname === '/qa/status/123') return route.fulfill({contentType:'text/html; charset=utf-8', body:html});
      if (['react.js', 'react-dom.js', 'Draft.js', 'immutable.js'].some(name => url.pathname === '/qa/' + name)) {
        return route.fulfill({path:fixtureScript(path.basename(url.pathname)), contentType:'application/javascript'});
      }
      return route.abort();
    });
    await page.addInitScript(({translation, chineseCheck, mode}) => {
      window.recorded = [];
      window.armed = false;
      window.chrome = {...window.chrome, runtime:{sendMessage:async msg => {
        window.recorded.push(msg);
        if (msg.action === 'translate') return {ok:true, text:translation, language:'en', sourceLanguage:'zh'};
        if (msg.action === 'backTranslate') return {ok:true, text:chineseCheck};
        throw Error('Unexpected test request: ' + msg.action);
      }}};
      // Let the user type normally. Only later programmatic selection updates are lost.
      window.addEventListener('selectionchange', e => { if (window.armed) e.stopImmediatePropagation(); }, true);
      if (mode === 'unresponsive') {
        for (const type of ['keyup','mouseup']) window.addEventListener(type, e => {
          if (window.armed && !e.isTrusted) e.stopImmediatePropagation();
        }, true);
      }
      if (mode === 'blocked') {
        const command = document.execCommand.bind(document);
        document.execCommand = (name,...args) =>
          window.armed && /^(inserttext|delete|paste)$/i.test(name) ? false : command(name,...args);
        for (const type of ['beforeinput','paste']) window.addEventListener(type, e => {
          if (window.armed) { e.preventDefault(); e.stopImmediatePropagation(); }
        }, true);
      }
    }, {translation, chineseCheck, mode});
    await page.goto('https://x.com/qa/status/123');
    const editor = page.locator('[contenteditable=true]');
    await editor.click();
    await editor.press('ControlOrMeta+a');
    const lines = original.split('\n');
    for (const [index,line] of lines.entries()) {
      if (index) await page.keyboard.press('Enter');
      await page.keyboard.insertText(line);
    }
    await page.waitForFunction(value => window.readModel() === value, original, {timeout:2500});
    await page.evaluate(() => {
      window.armed = true;
      window.simulatedSubmissions = [];
      document.querySelector('#post').onclick = () => window.simulatedSubmissions.push({tweet_text:window.readModel()});
    });
    for (const script of scripts) await page.addScriptTag({path:path.join(extension, script)});
    await page.locator('button[data-action=translate]').click();
    const host = page.locator('[data-xreply-translator]');
    const check = host.locator('[data-role=back-translation]');
    await page.waitForFunction(() => {
      const ui = document.querySelector('[data-xreply-translator]').shadowRoot;
      return !ui.querySelector('[data-action=undo]').hidden || !ui.querySelector('textarea[readonly]').hidden;
    }, undefined, {timeout:2500});

    const model = await page.evaluate(() => window.readModel());
    assert.equal(await editor.innerText(), model, 'Visible draft and controlled submit state differ');
    if (mode === 'stale') assert.equal(model, translation, 'Translation must replace the original draft');
    if (mode === 'blocked') assert.equal(model, original, 'Rejected writes must preserve the original draft');
    assert.ok(model === translation || model === original, 'An appended or otherwise partial draft would be submitted');
    await check.filter({hasText:chineseCheck}).waitFor({timeout:2500});
    const requests = await page.evaluate(() => window.recorded);
    assert.deepEqual(requests.map(m => m.action), ['translate','backTranslate']);
    assert.deepEqual(requests[1], {action:'backTranslate', text:translation, target:'zh'});
    assert.deepEqual(await page.evaluate(() => window.simulatedSubmissions), []);
    await page.locator('#post').click();
    assert.deepEqual(await page.evaluate(() => window.simulatedSubmissions), [{tweet_text:model}]);
    if (model === translation) {
      await page.locator('button[data-action=undo]').click();
      await page.waitForFunction(value => window.readModel() === value, original, {timeout:2500});
      assert.equal(await editor.innerText(), original);
      assert.equal(await check.isVisible(), false);
    } else {
      const fallback = host.locator('textarea[readonly]');
      assert.equal(await fallback.isVisible(), true);
      assert.equal(await fallback.inputValue(), translation);
      assert.match(await check.innerText(), /下方译文的回译/);
    }
    console.log('PASS', mode, JSON.stringify(original));
  } finally { await page.close(); }
}

(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_BIN, headless:true,
    args:['--disable-background-networking','--disable-sync']});
  try {
    await runCase(browser, '蓝灯亮', 'Blue lamp!', 'stale');
    await runCase(browser, '看一看\n蓝灯亮', 'Have a look.\nBlue lamp!', 'stale');
    await runCase(browser, '蓝灯亮', 'Blue lamp!', 'blocked');
    await runCase(browser, '看一看\n蓝灯亮', 'Have a look.\nBlue lamp!', 'unresponsive');
  } finally { await browser.close(); }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
