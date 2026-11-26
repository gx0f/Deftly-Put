// Exercise the composer against offline X-style pages with real browser clicks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

const extension = path.resolve(__dirname, '../../Deftly-Put/extension');
const scripts = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'))).content_scripts.flatMap(s => s.js);
const draft = 'Podemos pintar a miniatura de azul.';
const post = 'Quelle couleur pour la maquette ?';
const article = `<article data-testid="tweet"><a href="/fixture_owl/status/123"><time>10:00</time></a>
  <div data-testid="tweetText" lang="fr">${post}</div></article>`;

function composer(button = 'Post') {
  return `<div data-testid="tweetTextarea_0" contenteditable="true" role="textbox">${draft}</div>
    <div data-testid="toolBar"><button data-testid="tweetButtonInline">${button}</button></div>`;
}

const detailDialog = `${article}<button id="new-post">Post</button>
  <template><div role="dialog">${composer()}</div></template>
  <script>document.getElementById('new-post').onclick = () =>
    document.body.append(document.querySelector('template').content.cloneNode(true));</script>`;
const translated = article.replace('</article>', '<button>Show original</button></article>');
const cases = [
  {name:'timeline post', url:'/home', html:composer() + article, target:'default', retarget:true},
  {name:'composer survives an unpacked update', url:'/home', html:composer(), target:'default', upgraded:true},
  {name:'standalone compose page', url:'/compose/post', html:composer(), target:'default'},
  {name:'new post over detail view', url:'/fixture_owl/status/123', html:detailDialog, openDialog:true, target:'default'},
  {name:'explicit target on new post', url:'/compose/post', html:composer(), manual:'ja', target:'ja'},
  {name:'ordinary reply', url:'/fixture_owl/status/123', html:article + composer('Reply'), target:'auto', post, hint:'fr'},
  {name:'translated reply without source label', url:'/home',
   html:`<div role="dialog">${translated}${composer('Reply')}</div>`, blocked:/没有显示可识别的原文语言/},
  {name:'reply with missing parent', url:'/compose/post',
   html:`<div role="dialog"><span>Replying to @fixture_owl</span>${composer()}</div>`, blocked:/未能确定正在回复/},
  {name:'manual target for translated reply', url:'/home',
   html:`<div role="dialog">${translated}${composer('Reply')}</div>`, post, manual:'ko', target:'ko'},
  {name:'invalid custom target', url:'/compose/post', html:composer(), manual:'custom', custom:'und', blocked:/请输入目标语言代码/},
];

async function runCase(browser, fixture) {
  const page = await browser.newPage();
  page.setDefaultTimeout(3500);
  try {
    const url = 'https://x.com' + fixture.url;
    await page.route('**/*', route => route.request().url() === url
      ? route.fulfill({contentType:'text/html; charset=utf-8', body:`<!doctype html><main>${fixture.html}</main>`})
      : route.abort());
    await page.addInitScript(() => {
      window.requests = [];
      window.chrome = {runtime:{sendMessage:async message => {
        window.requests.push(message);
        const source = 'pt-BR', target = 'es';
        if (message.action === 'getLanguageSettings') return {ok:true, source, target};
        if (message.action === 'translate') {
          const language = message.target === 'default' ? target : message.target === 'auto' ? message.langHint : message.target;
          const text = {es:'La maqueta podría ser azul.', ja:'模型を青く塗れます。', fr:'La maquette pourrait être bleue.', ko:'모형을 파란색으로 칠할 수 있어요.'}[language];
          return {ok:true, text, language, sourceLanguage:source};
        }
        if (message.action === 'backTranslate') return {ok:true, text:'Podemos pintar a miniatura de azul.'};
        throw new Error('Unexpected message ' + message.action);
      }}};
    });
    await page.goto(url);
    if (fixture.upgraded) {
      await page.evaluate(() => {
        // A still-running older content script keeps its widgets next to X's editor and submit button.
        const editor = document.querySelector('[contenteditable=true]');
        const send = document.querySelector('[data-testid=tweetButtonInline]');
        const oldPanel = document.createElement('div'), oldActions = document.createElement('div');
        oldPanel.dataset.xreplyTranslator = oldActions.dataset.xreplyActions = '';
        oldPanel.dataset.xreplyVersion = oldActions.dataset.xreplyVersion = '1.2.1';
        function reattach() {
          if (editor.nextElementSibling !== oldPanel) editor.after(oldPanel);
          if (oldActions.nextElementSibling !== send) send.before(oldActions);
        }
        reattach();
        new MutationObserver(() => requestAnimationFrame(reattach))
          .observe(document.body, {subtree:true, childList:true});
      });
    }
    for (const script of scripts) await page.addScriptTag({path:path.join(extension, script)});
    if (fixture.upgraded) {
      const moves = await page.evaluate(async () => {
        const nextFrame = () => new Promise(requestAnimationFrame);
        for (let i = 0; i < 3; i++) await nextFrame();
        const actions = document.querySelector('[data-xreply-actions]:not([data-xreply-version="1.2.1"])');
        let removals = 0;
        const watch = new MutationObserver(records => {
          for (const record of records) if ([...record.removedNodes].includes(actions)) removals++;
        });
        watch.observe(actions.parentNode, {childList:true});
        for (let i = 0; i < 5; i++) await nextFrame();
        watch.disconnect();
        return removals;
      });
      assert.equal(moves, 0, 'Translate must stay mounted between pointerdown and click');
    }
    if (fixture.openDialog) await page.locator('#new-post').click();
    const settings = page.locator('[data-action="settings"]');
    const targets = page.locator('[data-field="target"]');
    await settings.click();
    if (fixture.manual) {
      await targets.locator(`[data-value="${fixture.manual}"]`).click();
      if (fixture.custom) await targets.getByRole('textbox').fill(fixture.custom);
    }
    const translate = page.locator('[data-action="translate"]');
    await translate.click();
    const translations = () => page.evaluate(() => window.requests.filter(m => m.action === 'translate'));
    if (fixture.blocked) {
      await page.getByRole('status').filter({hasText:fixture.blocked}).waitFor();
      assert.deepEqual(await translations(), []);
      assert.equal(await page.getByRole('textbox').first().innerText(), draft);
      return;
    }
    const check = page.locator('[data-role="back-translation"]').filter({hasText:draft});
    await check.waitFor();
    const [message] = await translations();
    assert.equal(message.target, fixture.target);
    assert.equal(message.post, fixture.post || '');
    assert.equal(message.langHint, fixture.hint || '');
    assert.equal(message.draft, draft);
    if (!fixture.post) assert.equal(message.lookupStatusId, undefined);
    const back = await page.evaluate(() => window.requests.find(m => m.action === 'backTranslate'));
    assert.equal(back.target, 'pt-BR');
    assert.equal(back.text, await page.getByRole('textbox').first().innerText());
    if (fixture.retarget) {
      await targets.locator('[data-value="ja"]').click();
      await translate.click();
      await page.waitForFunction(() => window.requests.filter(m => m.action === 'backTranslate').length === 2);
      const [, second] = await translations();
      assert.deepEqual([second.draft, second.target, second.source], [draft, 'ja', 'pt-BR']);
    }
  } finally {
    await page.close();
  }
}

(async () => {
  // Default to Playwright's own headless browser. Developers can supply a test binary.
  const browser = await chromium.launch({executablePath:process.env.CHROME_BIN, headless:true,
    args:['--disable-background-networking', '--disable-sync']});
  try {
    for (const fixture of cases) {
      try { await runCase(browser, fixture); } catch (err) { throw new Error(fixture.name + ': ' + err.message); }
      console.log('PASS', fixture.name);
    }
  } finally { await browser.close(); }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
