// Offline Draft.js fixture and the extension's real service-worker message handlers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fixtureScript} = require('../draft-qa/resources.cjs');
const vm = require('node:vm');
const {chromium} = require('playwright-core');

const project = path.resolve(__dirname, '../..');
const extension = path.join(project, 'Deftly-Put/extension');
const assets = path.join(project, 'work/draft-qa');
const translated = 'The model glider has blue wings.';
const original = '模型滑翔机有蓝色的翅膀。';
const template = fs.readFileSync(path.join(assets, 'fixture.html'), 'utf8');
const markup = template.slice(0, template.indexOf('  const {EditorState')) + `
  const {EditorState, ContentState, Editor} = Draft;
  function Entry() {
    const [state, update] = React.useState(() => EditorState.createWithContent(
      ContentState.createFromText(sessionStorage.getItem('fixture') || '')));
    window.readModel = () => state.getCurrentContent().getPlainText();
    return React.createElement(Editor, {editorState:state, onChange:update});
  }
  window.showPost = id => {
    const article = document.querySelector('article');
    article.querySelector('a').href = '/fixture_owl/status/' + id;
    article.querySelector('[data-testid=tweetText]').textContent = 'Workshop exhibit ' + id;
    history.replaceState(null, '', '/fixture_owl/status/' + id);
  };
  window.showPost(location.pathname.split('/').pop());
  ReactDOM.render(React.createElement(Entry), document.getElementById('draftApp'));
  document.querySelector('#post').onclick = () => window.submitted = window.readModel();
</script></body></html>`;

function worker() {
  const records = {}, listeners = [];
  let onClose;
  const chrome = {storage:{session:{
    get:async key => ({[key]:records[key]}),
    set:async entries => Object.assign(records, entries),
    remove:async keys => { for (const key of [].concat(keys)) delete records[key]; }
  }}, runtime:{
    id:'fixture-extension', getURL:name => 'chrome-extension://fixture-extension/' + name,
    onMessage:{addListener:f => listeners.push(f)}, onInstalled:{addListener() {}}
  }, tabs:{onRemoved:{addListener:f => { onClose = f; }}}};
  function load(file) { vm.runInContext(fs.readFileSync(path.join(extension,file),'utf8'), sandbox); }
  const sandbox = vm.createContext({chrome, URL, importScripts:load});
  load('background.js');
  function send(msg, tab, url) {
    return new Promise((resolve, reject) => {
      const sender = {id:chrome.runtime.id, frameId:0, tab:{id:tab}, url};
      if (!listeners.some(listener => listener(msg, sender, resolve))) reject(Error('No handler: ' + msg.action));
    });
  }
  return {records, send, onClose};
}

(async () => {
  const service = worker();
  const browser = await chromium.launch({executablePath:process.env.CHROME_BIN, headless:true, args:['--disable-background-networking','--disable-sync']});
  const context = await browser.newContext();
  let nextId = 0;
  async function tab() {
    const id = ++nextId;
    const page = await context.newPage();
    page.setDefaultTimeout(3500);
    await page.route('**/*', route => {
      const {origin, pathname} = new URL(route.request().url());
      if (origin !== 'https://x.com') return route.abort();
      if (/^\/fixture_owl\/status\/\d+$/.test(pathname)) return route.fulfill({contentType:'text/html;charset=utf-8', body:markup});
      if (/^\/qa\/(react|react-dom|immutable|Draft)\.js$/.test(pathname)) {
        return route.fulfill({contentType:'application/javascript', path:fixtureScript(path.basename(pathname))});
      }
      return route.abort();
    });
    await page.exposeBinding('workerMessage', (_, msg) => service.send(msg, id, page.url()));
    await page.addInitScript(({original, translated}) => {
      window.chrome = {runtime:{id:'fixture-extension', sendMessage:async msg => {
        if (msg.action === 'translate') {
          window.lastTranslation = msg;
          return {ok:true, text:msg.draft === '灯罩' ? 'Lampshade' : translated, sourceLanguage:'zh', language:'en'};
        }
        if (msg.action === 'backTranslate') return {ok:true, text:original};
        return window.workerMessage(msg);
      }}};
    }, {original, translated});
    async function open(post, text) {
      if (page.url() === 'about:blank') await page.goto('https://x.com/fixture_owl/status/' + post);
      await page.evaluate(text => sessionStorage.setItem('fixture', text), text);
      const url = 'https://x.com/fixture_owl/status/' + post;
      if (page.url() === url) await page.reload();
      else await page.goto(url);
      await page.addScriptTag({path:path.join(extension, 'content.js')});
    }
    async function generate() {
      await open(101, original);
      await page.locator('[data-action=translate]').click();
      await page.locator('[data-role=back-translation]').filter({hasText:original}).waitFor();
      assert.equal(await page.evaluate(() => window.readModel()), translated);
      await page.waitForFunction(async () => Boolean((await window.workerMessage({action:'writtenReply', operation:'read'})).record));
    }
    async function verifyText(expected) {
      await page.waitForFunction(text => window.readModel() === text, expected);
      assert.equal(await page.locator('[contenteditable=true]').innerText().then(text => text.trimEnd()), expected);
      await page.locator('#post').click();
      assert.equal(await page.evaluate(() => window.submitted), expected);
    }
    // Wait for storage, signature comparison, and any queued editor updates.
    const settle = () => page.waitForTimeout(180);
    return {id, page, open, generate, verifyText, settle};
  }
  try {
    const a = await tab();
    await a.generate();
    assert.ok(!JSON.stringify(service.records).includes(translated), 'The worker kept plaintext');
    await a.open(101, translated);
    await a.settle();
    await a.verifyText(translated);
    const b = await tab();
    await b.open(202, translated);
    await b.settle();
    await b.verifyText(translated);
    console.log('PASS same post after reload and other tab preserve draft');
    await a.open(202, translated);
    await a.page.getByRole('button', {name:'恢复上条回复的译文'}).waitFor();
    await a.verifyText('');
    await a.page.getByRole('button', {name:'恢复上条回复的译文'}).click();
    await a.verifyText(translated);
    await a.open(202, translated);
    await a.settle();
    await a.verifyText(translated);
    console.log('PASS carried reply cleared from submit model, restore persists');
    await a.generate();
    await a.page.evaluate(() => window.showPost(303));
    await a.page.getByRole('button', {name:'恢复上条回复的译文'}).waitFor();
    await a.verifyText('');
    console.log('PASS reused editor clears on a changed parent');
    await a.page.locator('[contenteditable=true]').click();
    await a.page.keyboard.insertText('灯罩');
    await a.page.locator('[data-action=translate]').click();
    await a.verifyText('Lampshade');
    assert.deepEqual(await a.page.evaluate(() => [window.lastTranslation.draft, window.lastTranslation.post]), ['灯罩', 'Workshop exhibit 303']);
    console.log('PASS a fresh Chinese draft translates against the second parent');
    await a.generate();
    await a.open(404, translated + ' My edit.');
    await a.settle();
    await a.verifyText(translated + ' My edit.');
    await a.open(404, '');
    await a.page.locator('[contenteditable=true]').click();
    await a.page.keyboard.insertText(translated);
    await a.settle();
    await a.verifyText(translated);
    await a.open(404, translated);
    await a.settle();
    await a.verifyText(translated);
    console.log('PASS edited draft and intentionally typed identical reply survive reload');
    await a.generate();
    await a.page.evaluate(() => {
      const button = document.createElement('button');
      button.dataset.testid = 'draftsButton';
      button.textContent = 'Drafts';
      document.body.append(button);
    });
    await a.page.getByRole('button', {name:'Drafts'}).click();
    await a.open(606, translated);
    await a.settle();
    await a.verifyText(translated);
    console.log('PASS explicitly opened saved draft keeps identical wording');
    await a.generate();
    await a.page.evaluate(() => {
      const article = document.querySelector('article');
      const preview = document.createElement('div');
      preview.innerHTML = '<span>@fixture_heron</span><div data-testid="tweetText" lang="en">A silver model turbine.</div>';
      const recipient = document.createElement('div');
      recipient.innerHTML = '<span>Replying to @fixture_heron</span>';
      article.replaceWith(preview, recipient);
    });
    await a.page.getByRole('button', {name:'恢复上条回复的译文'}).waitFor();
    await a.verifyText('');
    console.log('PASS compact preview with a verified different recipient');
    await a.generate();
    service.onClose(a.id);
    const read = await service.send({action:'writtenReply', operation:'read'}, a.id, a.page.url());
    assert.equal(read.record, null);
    console.log('PASS closed-tab cleanup');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
