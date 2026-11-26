// Keep one X-style compose dialog and editor mounted while changing the parent post.
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright-core');

async function run(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(3500);
  try {
    await page.route('**/*', route => route.fulfill({contentType:'text/html;charset=utf-8', body:`
      <main><article data-testid="tweet">
        <a href="/fixture_owl/status/123"><time>10:00</time></a>
        <div data-testid="tweetText">The display case needs a label.</div>
        <button data-testid="reply" onclick="this.closest('main').append(document.querySelector('template').content.cloneNode(true))">Reply to Alex</button>
      </article><template><div role="dialog"><article data-testid="tweet">
        <a href="/fixture_owl/status/123"><time>10:00</time></a>
        <div data-testid="tweetText" lang="en">The display case needs a label.</div></article>
        <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
        <div data-testid="toolBar"><button data-testid="tweetButton">Reply</button></div></div></template></main>`}));
    await page.addInitScript(() => {
      window.requests = [];
      window.answers = [];
      window.chrome = {runtime:{sendMessage:async message => {
        if (message.action === 'translate') {
          window.requests.push(message);
          return new Promise(resolve => window.answers.push(text => resolve({ok:true, text, language:'en', sourceLanguage:'zh'})));
        }
        if (message.action === 'backTranslate') return {ok:true, text:'标签已备好。'};
        if (message.action === 'detectEditLanguage') return {ok:true, language:''};
        if (message.action === 'getLanguageSettings') return {ok:true, target:'en', source:'zh'};
        throw Error('Unexpected action ' + message.action);
      }}};
    });
    await page.goto('https://x.com/home');
    await page.addScriptTag({path:path.resolve(__dirname, '../../Deftly-Put/extension/content.js')});
    await page.getByRole('button', {name:'Reply to Alex'}).click();
    const editor = page.getByTestId('tweetTextarea_0');
    const button = page.locator('[data-action="translate"]');
    const check = page.locator('[data-role="back-translation"]');
    const fallback = page.locator('textarea[readonly]');
    const request = async index => {
      await page.waitForFunction(index => window.requests.length > index, index, {timeout:3000});
      return page.evaluate(index => window.requests[index], index);
    };
    const answer = (index, text) => page.evaluate(([i,t]) => window.answers[i](t), [index,text]);
    const expectedText = text => page.waitForFunction(text => document.querySelector('[contenteditable]').innerText === text, text);

    await editor.fill('给展品取名。');
    await button.click();
    assert.equal((await request(0)).draft, '给展品取名。');
    await answer(0, 'Give it the name Paper Moon Atlas.');
    await check.filter({hasText:'标签已备好。'}).waitFor();

    // The retained book title makes this look like a tweak to the last translation.
    await editor.fill('我想写一本叫作 Paper Moon Atlas 的地图册。');
    await button.click();
    assert.equal((await request(1)).draft, '我想写一本叫作 Paper Moon Atlas 的地图册。');
    console.log('PASS explicit translate after a mixed-language rewrite');

    // X reuses the exact same dialog, editor, widget and /home URL for another parent.
    await page.evaluate(() => {
      document.querySelector('[role=dialog] article a').href = '/fixture_owl/status/456';
      const parent = document.querySelector('[role=dialog] article');
      parent.querySelector('[data-testid="tweetText"]').textContent = 'Which label goes on the blue vase?';
      parent.insertAdjacentHTML('beforeend', '<span>翻译自 英语</span><button>显示原文</button><div data-testid="quoteTweet"><div data-testid="tweetText">Quoted post</div></div>');
    });
    await editor.fill('贴上蓝色标签。');
    await button.click();
    const secondPost = await request(2);
    assert.deepEqual([secondPost.post, secondPost.draft, secondPost.target], ['Which label goes on the blue vase?', '贴上蓝色标签。', 'en']);
    await answer(1, 'A paper atlas.');
    assert.equal(await button.isDisabled(), true);
    assert.equal(await editor.innerText(), '贴上蓝色标签。');
    assert.equal(await fallback.isVisible(), false);
    await answer(2, 'Use the blue label.');
    await expectedText('Use the blue label.');
    await check.filter({hasText:'标签已备好。'}).waitFor();
    console.log('PASS changing posts during a pending request leaves the next request and draft intact');

    await editor.fill('把展柜关上。');
    await button.click();
    assert.equal((await request(3)).draft, '把展柜关上。');
    await editor.fill('请把木制展柜关好。');
    await button.click();
    assert.equal((await request(4)).draft, '请把木制展柜关好。');
    await answer(4, 'Please close the wooden case.');
    await expectedText('Please close the wooden case.');
    await answer(3, 'Close the case.');
    assert.equal(await fallback.isVisible(), false);
    assert.equal(await editor.innerText(), 'Please close the wooden case.');
    console.log('PASS rewriting and translating the same reply again before the previous request finishes');

    await check.filter({hasText:'标签已备好。'}).waitFor();
    await editor.fill('');
    await editor.focus();
    const session = await page.context().newCDPSession(page);
    const candidate = '请备好绿色纸。';
    await session.send('Input.imeSetComposition', {text:candidate, selectionStart:candidate.length, selectionEnd:candidate.length});
    await button.click();
    assert.equal((await request(5)).draft, candidate);
    await editor.fill('我刚改成了黄色纸。');
    await answer(5, 'Prepare the green paper.');
    await fallback.waitFor();
    assert.equal(await fallback.inputValue(), 'Prepare the green paper.');
    assert.equal(await editor.innerText(), '我刚改成了黄色纸。');
    console.log('PASS clicking Translate commits Chinese IME input and subsequent editing preserves the unsent draft');
  } finally {
    await page.close();
  }
}

(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_BIN, headless:true,
    args:['--disable-sync', '--disable-background-networking']});
  try { await run(browser); } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
