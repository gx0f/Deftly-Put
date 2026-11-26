/* Run from the project root: node work/qa/first-delete.cjs path/to/extension */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fixtureScript} = require('../draft-qa/resources.cjs');
const {chromium} = require('playwright-core');

const extension = path.resolve(process.argv[2] || 'Deftly-Put/extension');
const assets = path.resolve('work/draft-qa');
const template = fs.readFileSync(path.join(assets, 'fixture.html'), 'utf8');
const english = 'Blue lamp!';
const markup = template.slice(0, template.indexOf('  const {EditorState')) + `
  const {EditorState, ContentState, CompositeDecorator, Editor} = Draft;
  function Form() {
    const [state, setState] = React.useState(() => {
      const decorator = window.decorate ? new CompositeDecorator([{
        strategy(block, callback) {
          const offset = block.getText().indexOf('lamp');
          if (offset >= 0) callback(offset, offset + 4);
        },
        component: props => React.createElement('span', null, props.children)
      }]) : null;
      return EditorState.createWithContent(ContentState.createFromText('蓝灯亮'), decorator);
    });
    window.model = () => state.getCurrentContent().getPlainText();
    window.modelSelection = () => state.getSelection();
    return React.createElement(Editor, {editorState:state, onChange:setState});
  }
  ReactDOM.render(React.createElement(Form), document.getElementById('draftApp'));
  document.getElementById('post').onclick = () => window.submission = window.model();
  // X's FloatingFormatToolbar reads the DOM range on document mouseup/keyup,
  // mounts into document.body, and delays its close animation by 120 ms.
  const editor = document.querySelector('[contenteditable=true]');
  let queued = false, closing, keyboardRange = false;
  window.formatClicks = 0;
  window.formatRequests = 0;
  window.formatFrames = {dom:0, model:0, keyup:0};
  function onSelectionAction(event) {
    const menu = document.getElementById('format-tools');
    if (event.type === 'mouseup' && menu?.contains(event.target)) return;
    const range = document.getSelection();
    const expanded = !range.isCollapsed && editor.contains(range.anchorNode) && editor.contains(range.focusNode);
    if (event.type === 'keyup') keyboardRange = expanded;
    if (!expanded) {
      if (menu && !closing) closing = setTimeout(() => { menu.remove(); closing = null; }, 120);
      return;
    }
    window.formatRequests++;
    clearTimeout(closing);
    closing = null;
    if (queued || menu) return;
    queued = true;
    setTimeout(() => {
      const bar = document.createElement('div');
      bar.id = 'format-tools';
      bar.style.cssText = 'position:fixed;right:12px;top:10px;background:black;color:white';
      bar.innerHTML = '<button aria-label="Bold">B</button><button aria-label="Italic">I</button>';
      bar.addEventListener('mousedown', e => e.preventDefault());
      bar.addEventListener('click', () => window.formatClicks++);
      document.body.append(bar);
      queued = false;
    }, 20);
  }
  document.addEventListener('mouseup', onSelectionAction);
  document.addEventListener('keyup', onSelectionAction);
  function paintSelection() {
    const dom = document.getSelection(), model = window.modelSelection();
    const domRange = !dom.isCollapsed && editor.contains(dom.anchorNode) && editor.contains(dom.focusNode);
    const modelRange = model.getHasFocus() && !model.isCollapsed();
    if (domRange) window.formatFrames.dom++;
    if (modelRange) window.formatFrames.model++;
    if (keyboardRange) window.formatFrames.keyup++;
    requestAnimationFrame(paintSelection);
  }
  requestAnimationFrame(paintSelection);
</script></body></html>`;

async function caretPoint(page, offset) {
  return page.locator('[contenteditable=true]').evaluate((editor, position) => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let leaf = walker.nextNode(); leaf; leaf = walker.nextNode()) {
      if (position > leaf.length) { position -= leaf.length; continue; }
      const range = document.createRange();
      range.setStart(leaf, position);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      return {x:rect.left + 0.15, y:rect.top + rect.height / 2};
    }
    throw new Error('Requested character is absent');
  }, offset);
}

async function expectNoFormatFrames(page) {
  // Include a painted frame after the last write and pending selectionchange.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => window.formatRequests), 0, 'X queued its formatting portal during an extension edit');
  assert.equal(await page.locator('#format-tools').count(), 0, 'X mounted an orphan formatting portal');
  assert.deepEqual(await page.evaluate(() => window.formatFrames), {dom:0, model:0, keyup:0},
    'A visible frame showed the formatting toolbar during an extension edit');
  assert.ok(await page.evaluate(() => document.getSelection().isCollapsed && window.modelSelection().isCollapsed()),
    'DOM or Draft selection was left expanded');
}

async function expectUserSelection(page, text) {
  await page.locator('#format-tools').waitFor({state:'visible', timeout:1500});
  await page.waitForFunction(value => document.getSelection().toString() === value && !window.modelSelection().isCollapsed(),
    text, {timeout:1500});
}

async function check(browser, decorated, action, staleSelection = false) {
  const page = await browser.newPage({hasTouch:action === 'touch'});
  try {
    await page.route('**/*', route => {
      const {origin, pathname} = new URL(route.request().url());
      if (origin === 'https://x.com' && pathname === '/fixture_owl/status/12345') {
        return route.fulfill({body:markup, contentType:'text/html;charset=utf-8'});
      }
      if (origin === 'https://x.com' && /^\/qa\/(react|react-dom|immutable|Draft)\.js$/.test(pathname)) {
        return route.fulfill({path:fixtureScript(path.basename(pathname)), contentType:'application/javascript'});
      }
      return route.abort();
    });
    await page.addInitScript(({decorated, english, staleSelection, rejectWrites}) => {
      window.decorate = decorated;
      if (rejectWrites) {
        const command = document.execCommand.bind(document);
        document.execCommand = (name, ...args) => /^(insertText|delete|forwardDelete|paste)$/i.test(name) ? false : command(name, ...args);
        for (const type of ['beforeinput', 'paste']) document.addEventListener(type, event => {
          event.preventDefault();
          event.stopImmediatePropagation();
        }, true);
      }
      if (staleSelection) {
        // X can keep its old model selection even though Chrome highlights
        // the full phrase. Restore ordinary mouse/keyboard editing afterwards.
        for (const type of ['selectionchange', 'keyup', 'mouseup']) {
          window.addEventListener(type, event => {
            if (!window.translationWritten && (type === 'selectionchange' || !event.isTrusted)) event.stopImmediatePropagation();
          }, true);
        }
      }
      window.chrome = {runtime:{sendMessage:async request => {
        if (request.action === 'translate') return {ok:true, text:english, language:'en', sourceLanguage:'zh'};
        if (request.action === 'backTranslate') {
          window.translationWritten = true;
          return new Promise(resolve => { window.finishCheck = () => resolve({ok:true, text:'蓝灯好亮！'}); });
        }
      }}};
    }, {decorated, english, staleSelection, rejectWrites:action === 'fallback'});
    await page.goto('https://x.com/fixture_owl/status/12345');
    await page.addScriptTag({path:path.join(extension, 'content.js')});
    await page.locator('button[data-action=translate]').click();
    await page.waitForFunction(() => window.translationWritten, undefined, {timeout:2500});
    const editor = page.locator('[contenteditable=true]');
    const panel = page.locator('[data-xreply-translator]');
    await expectNoFormatFrames(page);
    if (action === 'fallback') {
      assert.equal(await panel.locator('textarea[readonly]').inputValue(), english);
      assert.equal(await editor.innerText(), '蓝灯亮');
      assert.equal(await page.evaluate(() => window.model()), '蓝灯亮');
      await page.evaluate(() => window.finishCheck());
      await expectNoFormatFrames(page);
      console.log('PASS rejected write, no format toolbar');
      return;
    }
    assert.equal(await editor.innerText(), english);
    if (action === 'open-menu') {
      await page.keyboard.press('End');
      await page.keyboard.press('Shift+ArrowLeft');
      await expectUserSelection(page, '!');
      const opened = await page.evaluate(() => window.formatRequests);
      await panel.locator('[data-action=undo]').click();
      await page.locator('#format-tools').waitFor({state:'detached', timeout:1500});
      assert.equal(await page.evaluate(() => window.formatRequests), opened, 'Undo reopened the existing menu');
      assert.equal(await editor.innerText(), '蓝灯亮');
      console.log('PASS prior user-opened menu closes on undo');
      return;
    }
    if (action === 'undo') {
      await page.evaluate(() => window.finishCheck());
      await expectNoFormatFrames(page);
      const undo = panel.locator('[data-action=undo]');
      await undo.click();
      await undo.waitFor({state:'hidden', timeout:2500});
      assert.equal(await editor.innerText(), '蓝灯亮');
      assert.equal(await page.evaluate(() => window.model()), '蓝灯亮');
      await expectNoFormatFrames(page);
      console.log('PASS undo, no format toolbar');
      return;
    }
    let expected;
    if (action === 'touch') {
      // Desktop headless has no mobile OS handles. A trusted touch gesture
      // still has to authorize the selection delivered by the platform.
      await editor.evaluate(el => el.addEventListener('mouseup', () => {
        const leaf = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
        document.getSelection().setBaseAndExtent(leaf, 0, leaf, 4);
      }, {once:true}));
      const point = await caretPoint(page, 2);
      await page.touchscreen.tap(point.x, point.y);
      await expectUserSelection(page, 'Blue');
      await page.keyboard.press('ArrowRight');
      await page.locator('#format-tools').waitFor({state:'hidden'});
      console.log('PASS touch selection and collapse');
      return;
    }
    if (action === 'arrows') {
      await page.keyboard.press('End');
      await page.keyboard.press('Shift+ArrowLeft');
      await expectUserSelection(page, '!');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Backspace');
      expected = 'Blue lam!';
    } else {
      const start = await caretPoint(page, action === 'selection' ? 2 : 3);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      if (action === 'selection') {
        const end = await caretPoint(page, 4);
        await page.mouse.move(end.x, end.y, {steps:5});
      }
      await page.mouse.up();
      if (action === 'selection') {
        await expectUserSelection(page, 'ue');
        await page.locator('#format-tools button').first().click();
        assert.equal(await page.evaluate(() => window.formatClicks), 1);
        assert.equal(await page.evaluate(() => document.getSelection().toString()), 'ue');
      }
      await page.keyboard.press(action === 'delete' ? 'Delete' : 'Backspace');
      expected = {backspace:'Ble lamp!', delete:'Blu lamp!', selection:'Bl lamp!'}[action];
    }
    await page.waitForFunction(text => window.model() === text, expected, {timeout:1500});
    assert.equal(await editor.innerText(), expected);
    await page.locator('#format-tools').waitFor({state:'hidden', timeout:1500});
    await page.evaluate(() => window.finishCheck());
    assert.equal(await panel.locator('[data-role=back-translation]').isVisible(), false);
    assert.equal(await panel.locator('[data-action=undo]').isVisible(), false);
    assert.equal(await page.evaluate(() => window.submission), undefined);
    await page.locator('#post').click(); // Local fixture captures the value a submit handler would receive.
    assert.equal(await page.evaluate(() => window.submission), expected);
    console.log('PASS', decorated ? 'decorated' : 'plain', action, staleSelection ? '(stale model selection)' : '');
  } finally { await page.close(); }
}

(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_BIN,
    headless:true, args:['--disable-sync', '--disable-background-networking', '--disable-extensions']});
  try {
    for (const decorated of [false, true]) {
      for (const action of ['backspace','delete','selection','arrows']) await check(browser, decorated, action);
    }
    await check(browser, false, 'backspace', true);
    await check(browser, true, 'delete', true);
    await check(browser, false, 'undo');
    await check(browser, false, 'fallback');
    await check(browser, false, 'touch');
    await check(browser, false, 'open-menu');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
