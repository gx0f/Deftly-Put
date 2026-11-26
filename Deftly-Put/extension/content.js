(() => {
  "use strict";

  const VERSION = "1.2.2";
  if (globalThis.__xReplyTranslatorVersion === VERSION) return;
  globalThis.__xReplyTranslatorVersion = VERSION;
  const rules = document.getElementById("xreply-active-widget-version") || document.createElement("style");
  rules.id = "xreply-active-widget-version";
  rules.dataset.xreplyVersion = VERSION;
  rules.textContent = ':is([data-xreply-translator], [data-xreply-actions]):not([data-xreply-version="' + VERSION + '"]) { display: none !important; }' +
    ' [data-xreply-toolbar-row] { flex-wrap: wrap !important; row-gap: 4px; }';
  if (!rules.isConnected) document.documentElement.append(rules);

  const EDITOR = '[data-testid^="tweetTextarea_"][contenteditable="true"], [data-testid^="tweetTextarea_"] [contenteditable="true"]';
  const ARTICLE = 'article[data-testid="tweet"], article[role="article"]';
  const TEXT = '[data-testid="tweetText"]';
  const AUTHOR = '[data-testid="User-Name"], [data-testid="UserName"]';
  const QUOTE = '[data-testid="quoteTweet"], [data-testid="card.wrapper"]';
  const DIALOG = '[role="dialog"], [aria-modal="true"]';
  const POST_CARD = 'button, [role="button"], [role="link"]:not(a)';
  const quoteLabel = /^(?:引用(?:帖文|推文|帖子)?|quote(?:d)?(?: post| tweet)?|引用ポスト|인용(?: 게시물)?)$/i;
  const bindings = new WeakMap();
  let pendingReply = null;
  let scheduled = false;

  function statusId(url) {
    return (url || "").match(/\/status\/(\d+)(?:[/?#]|$)/)?.[1] || "";
  }

  function statusLink(article) {
    // The timestamp permalink belongs to the author of this reply, unlike quote links.
    for (const time of article.querySelectorAll("a[href] time")) {
      if (inQuote(time, article)) continue;
      const link = time.closest("a");
      if (["x.com", "twitter.com"].includes(link.hostname) && link.protocol === "https:" &&
          /^\/(?:[\w]{1,15}|i\/web)\/status\/\d{1,20}\/?$/.test(link.pathname)) return link;
    }
    return null;
  }

  function articleId(article) {
    const link = statusLink(article);
    if (link) return statusId(link.pathname);
    return "";
  }

  function inQuote(node, boundary) {
    for (let el = node; el && el !== boundary; el = el.parentElement) {
      if (el.matches(QUOTE) || el.matches(ARTICLE)) return true;
      if (el.hasAttribute("aria-labelledby")) {
        const ids = el.getAttribute("aria-labelledby").split(/\s+/);
        if (ids.some(id => {
          const label = document.getElementById(id);
          return label && el.contains(label) && quoteLabel.test(label.textContent.trim());
        })) return true;
      }
      // X renders a quoted post as a focusable button under its own accessible
      // label. A translation toggle, mention, or ordinary link isn't a post.
      if (el.matches(POST_CARD) && (el.querySelector(TEXT + ', ' + AUTHOR + ', ' + ARTICLE) ||
          el.querySelector('div[dir="auto"]') || el.querySelector('a[href*="/status/"]'))) return true;
    }
    return false;
  }

  function ownedText(scope) {
    const owned = node => !node.closest('[hidden], [aria-hidden="true"], [contenteditable], ' + AUTHOR) &&
      !inQuote(node, scope);
    const tagged = [...scope.querySelectorAll(TEXT)].filter(owned);
    if (tagged.length) return tagged.length === 1 ? tagged[0] : null;
    // Compact previews can omit tweetText. X's body is a separate directed
    // text block; the author, source label, quote and composer are siblings.
    const body = [...scope.querySelectorAll('div[dir="auto"], div[lang][dir], p[lang]')].filter(node =>
      owned(node) && !node.closest('button, a') && !node.querySelector('button, [role="button"], a[href*="/status/"], [contenteditable], ' + AUTHOR) &&
      !attributionLabel(node.textContent) && !/^@[A-Za-z0-9_]{1,15}$/.test(node.textContent.trim()));
    return body.length === 1 ? body[0] : null;
  }

  function readText(node, omitted = null) {
    if (!node) return "";
    // X can render emoji using <img alt> and mention text in nested spans.
    function textOf(part) {
      if (part === omitted) return "";
      if (part.nodeType === Node.TEXT_NODE) return part.nodeValue;
      if (part.nodeType !== Node.ELEMENT_NODE) return "";
      if (part.tagName === "IMG") return part.getAttribute("alt") || "";
      if (part.tagName === "BR") return "\n";
      return Array.from(part.childNodes, textOf).join("");
    }
    return textOf(node);
  }

  function draftOf(editor) {
    const lines = [...editor.querySelectorAll('[data-block="true"]')];
    if (lines.length) return lines.map(block => {
      const text = readText(block);
      return text === "\n" && block.querySelector("br:only-child") ? "" : text;
    }).join("\n");
    if (editor.childNodes.length === 1 && editor.firstChild.nodeName === "BR") return "";
    if (editor.querySelector("div, p") && !editor.querySelector("img")) return editor.innerText;
    return readText(editor);
  }

  // X translates the body in place. Its lang attribute may therefore describe the
  // reader's Chinese text, while the separate X attribution names the author's language.
  const sourceCodes = ("aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu fil yue ceb ckb zh-Hans zh-Hant pt-BR pt-PT es-419").split(" ");
  const languageNames = new Map();
  const sourceAttrs = ["data-original-language", "data-source-language", "data-original-lang", "data-source-lang"];
  const metadataAttrs = sourceAttrs.map(key => "[" + key + "]").join(",");
  const showOriginal = /(?:显示原文|顯示原文|查看原文|檢視原文|查看原帖|原文を表示|원문\s*보기|show original|view original|see original|mostrar (?:el )?original|ver (?:o )?original|afficher l.original|voir l.original|original anzeigen|vis original|mostra originale)/i;
  const sourcePrefix = /^(?:翻[译譯]自|[译譯]自|translated from|traduit(?:e)? (?:depuis|de l[’']|du|de la|de)|traducid[oa] (?:desde el|desde|del|de)|traduzid[oa] (?:do|da|de)|(?:automatisch )?übersetzt aus(?: dem)?|tradott[oa] (?:dal|dall[’']|da))\s*[:：]?\s*/i;
  const sourceSuffix = /^(.+?)(?:から(?:の)?翻訳|에서\s*번역(?:됨)?)/;
  const unknownLanguage = /^(und|mul|zxx)$/i;

  function normalizedName(value) {
    return value.normalize("NFKC").toLowerCase().replace(/[\u200e\u200f\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
  }

  function resolveName(label) {
    const key = normalizedName(label);
    if (!key) return "";
    // DOM source attributes may already contain a language tag.
    if (sourceCodes.includes(key) || /^[a-z]{2,3}-[a-z0-9-]+$/i.test(label)) {
      return canonicalLanguage(label);
    }
    const aliases = {"英文":"en","日文":"ja","韩文":"ko","韓文":"ko","德文":"de","法文":"fr","简体中文":"zh-Hans","繁體中文":"zh-Hant","繁体中文":"zh-Hant"};
    if (Object.hasOwn(aliases, key)) return aliases[key];
    for (const locale of new Set([document.documentElement.lang, navigator.language, "zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt", "it"])) {
      if (!locale) continue;
      if (!languageNames.has(locale)) {
        const names = new Map();
        try {
          const display = new Intl.DisplayNames([locale], {type:"language", fallback:"none"});
          for (const code of sourceCodes) {
            const name = display.of(code);
            if (name) names.set(normalizedName(name), code);
          }
        } catch { /* X can supply a locale unknown to this browser. */ }
        languageNames.set(locale, names);
      }
      const code = languageNames.get(locale).get(key);
      if (code) return code;
    }
    return "";
  }

  function attributionLabel(value) {
    if (!value || value.length > 160) return null;
    const text = value.trim();
    const prefix = text.match(sourcePrefix);
    const suffix = text.match(sourceSuffix);
    const toggleAt = text.search(showOriginal);
    if (!prefix && !suffix) return toggleAt === 0 ? {language:""} : null;
    const beforeToggle = toggleAt >= 0 ? text.slice(0, toggleAt) : text;
    const name = suffix ? suffix[1] : beforeToggle.slice(prefix[0].length);
    const clean = name.replace(/\s*(?:[·•|]|\s+by\s+(?:grok|google)|由\s*(?:grok|google)).*$/i, "").trim();
    return {language:resolveName(clean)};
  }

  function embeddedAttribution(node) {
    // Some renderers put the X attribution bar inside tweetText. Never parse
    // arbitrary authored text here: require X's own translation widget AND a
    // real "show original" control inside it.
    if (!node) return null;
    for (const bar of node.querySelectorAll('[data-testid*="translat" i]')) {
      if (bar.closest(TEXT) !== node || inQuote(bar, node)) continue;
      const buttons = [bar, ...bar.querySelectorAll('button, [role="button"]')];
      const hasToggle = buttons.some(button => button.matches('button, [role="button"]') &&
        [button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent].some(label => label && showOriginal.test(label)));
      if (!hasToggle) continue;
      const labels = [bar.getAttribute("aria-label"), bar.getAttribute("title"), bar.textContent];
      const name = labels.map(attributionLabel).find(evidence => evidence?.language)?.language;
      for (const key of sourceAttrs) {
        const tag = bar.getAttribute(key)?.trim() || "";
        if (tag && !unknownLanguage.test(tag) && canonicalLanguage(tag)) return {bar, language:canonicalLanguage(tag)};
      }
      return {bar, language:name || ""};
    }
    return null;
  }

  function originalLanguage(node, embedded = embeddedAttribution(node), scope = node?.closest(ARTICLE + ', ' + DIALOG)) {
    if (!scope) return null;
    const excluded = TEXT + ', div[lang][dir], [contenteditable], ' + AUTHOR + ', [data-xreply-translator], [hidden], [aria-hidden="true"]';
    const nestedContent = excluded + ', ' + ARTICLE + ', ' + QUOTE;
    const inScope = el => !inQuote(el, scope);
    const candidates = new Set();
    const languages = new Set();
    let detected = Boolean(embedded);
    function record(evidence) {
      if (!evidence) return;
      detected = true;
      if (evidence.language) languages.add(evidence.language);
    }
    record(embedded);
    // Explicit X metadata is first choice. A plain lang on the tweet is never
    // evidence for the original language when the translation label is visible.
    for (const el of [scope, ...scope.querySelectorAll(metadataAttrs)]) {
      if (!inScope(el) || (el !== node && el.closest(excluded))) continue;
      for (const key of sourceAttrs) {
        const tag = el.getAttribute(key)?.trim();
        if (tag && !unknownLanguage.test(tag)) {
          const resolved = canonicalLanguage(tag) || resolveName(tag);
          if (resolved) record({language:resolved});
        }
      }
    }
    for (const el of scope.querySelectorAll("span, div, button, a, [aria-label], [title]")) {
      if (!inScope(el) || el.closest(excluded) || (node && (node.contains(el) || el.contains(node))) || el.querySelector(nestedContent)) continue;
      candidates.add(el);
    }
    for (const el of candidates) {
      // Do not scan tweet text or a quoted post for source-language claims.
      // Checking parent containers as well as leaves supports labels split over spans.
      const values = [el.getAttribute("aria-label"), el.getAttribute("title"), el.textContent];
      for (const value of values) {
        const evidence = attributionLabel(value);
        if (!evidence) continue;
        record(evidence);
        // Some X layouts put the prefix, language name and original-text switch in
        // separate siblings directly beside the actual body.
        const next = el.nextElementSibling;
        if (value && sourcePrefix.test(value.trim()) && next && candidates.has(next)) {
          const combined = attributionLabel(value + " " + next.textContent);
          record(combined);
        }
      }
    }
    return detected ? {language:languages.size === 1 ? [...languages][0] : "", ambiguous:languages.size > 1} : null;
  }

  function contextOf(node, binding, scope = node?.closest(ARTICLE + ', ' + DIALOG)) {
    if (!scope) return null;
    const embedded = embeddedAttribution(node);
    const post = readText(node, embedded?.bar).trim();
    const lang = node?.getAttribute("lang") || "";
    const source = originalLanguage(node, embedded, scope);
    // The reply dialog may repeat the same post without its translation attribution.
    const clicked = binding?.clicked;
    const id = articleId(scope);
    const sameParent = clicked && (id ? clicked.id === id : clicked.article === scope || (post && post === clicked.post));
    const previous = sameParent ? clicked.source : null;
    const original = source?.ambiguous ? "" : source?.language || previous?.language || "";
    if (!post && !source && !previous) return null;
    const hint = !unknownLanguage.test(lang) ? canonicalLanguage(lang) : "";
    return {post, scope, langHint:original || (!source && !previous ? hint : ""), original, id: id || (sameParent && clicked.id) || "",
      translated:Boolean(source || previous)};
  }

  const validStatus = value => typeof value === "string" && /^\d{1,20}$/.test(value);
  const detailId = () => location.pathname.match(/^\/(?:\w{1,15}|i\/web)\/status\/(\d{1,20})\/?$/)?.[1] || "";
  const maxAncestors = 3;
  const cellSelector = '[data-testid="cellInnerDiv"]';
  const threadBoundary = '[data-testid="placementTracking"], [data-testid="promotedIndicator"], [data-testid="UserCell"], [data-testid="trend"]';

  function threadPost(scope) {
    const body = ownedText(scope);
    const text = readText(body, embeddedAttribution(body)?.bar).trim();
    if (!text) return null;
    const name = statusLink(scope)?.pathname.split("/")[1];
    let author = name && name !== "i" ? "@" + name : "";
    if (!author) {
      const header = [...scope.querySelectorAll(AUTHOR)].find(el => !inQuote(el, scope));
      const handle = header && [...header.querySelectorAll("span,a")].map(el => el.textContent.trim())
        .find(value => /^@[A-Za-z0-9_]{1,15}$/.test(value));
      if (handle) author = handle;
    }
    return {author, text:Array.from(text).slice(0, 1000).join("")};
  }

  function directQuote(scope) {
    const cards = new Set();
    for (const node of scope.querySelectorAll(TEXT)) {
      if (node.closest('[hidden], [aria-hidden="true"]') || !inQuote(node, scope)) continue;
      const card = node.closest(ARTICLE + ', ' + QUOTE + ', ' + POST_CARD);
      if (card && card !== scope && scope.contains(card) && ownedText(card) === node) cards.add(card);
    }
    if (cards.size !== 1) return null;
    const card = [...cards][0];
    const post = threadPost(card);
    // A generic linked media preview can contain text, but isn't a quoted author.
    return post?.author && (statusLink(card) || card.querySelector(AUTHOR)) ? post : null;
  }

  function parentIdOf(scope) {
    // Require relationship metadata. A status URL pasted into a tweet body
    // or a link in an embedded quote identifies neither tweet's parent.
    const rel = '[data-in-reply-to-status-id], [data-parent-status-id], [data-reply-to-status-id]';
    const ids = new Set();
    for (const el of [scope, ...scope.querySelectorAll(rel + ', a[rel~="up"], [data-testid="inReplyTo"] a[href]')]) {
      if (inQuote(el, scope) || el.closest(TEXT + ', ' + AUTHOR + ', [contenteditable]')) continue;
      for (const attr of ["data-in-reply-to-status-id", "data-parent-status-id", "data-reply-to-status-id"]) {
        const id = el.getAttribute(attr);
        if (validStatus(id)) ids.add(id);
      }
      if (el.matches("a[href]") && el.protocol === "https:" && ["x.com","twitter.com"].includes(el.hostname)) {
        const id = statusId(el.pathname);
        if (validStatus(id)) ids.add(id);
      }
    }
    return ids.size > 1 ? null : [...ids][0] || "";
  }

  function replyRecipient(scope) {
    for (const el of scope.querySelectorAll('a[href], span')) {
      const line = el.parentElement;
      if (!line || line.closest(TEXT + ', ' + AUTHOR) || inQuote(line, scope) || line.textContent.length > 160) continue;
      const match = line.textContent.trim().match(/^(?:replying to|回复(?:给)?|回覆(?:給)?)\s*(@[\w]{1,15})\b/i);
      if (match) return match[1].toLowerCase();
    }
    return "";
  }

  function conversationList(article) {
    const conversation = /^(?:(?:timeline|时间线|時間軸|タイムライン|cronolog[ií]a|fil|linha do tempo|chronik|타임라인)\s*[:：]\s*)?(?:conversation|conversación|conversa|conversazione|unterhaltung|对话|對話|会话|會話|会話|대화)$/i;
    for (let el = article.parentElement; el && !el.matches('main, body'); el = el.parentElement) {
      if (el.matches('[data-testid="conversationTimeline"]') || conversation.test(el.getAttribute("aria-label")?.trim() || "")) return el;
      if (el.matches("section[aria-labelledby]")) {
        const labels = el.getAttribute("aria-labelledby").split(/\s+/);
        if (labels.some(id => conversation.test(document.getElementById(id)?.textContent.trim() || ""))) return el;
      }
    }
    return null;
  }

  function topArticles(scope, dialog = null) {
    return [...scope.querySelectorAll(ARTICLE)].filter(el => el.closest(DIALOG) === dialog &&
      !el.closest('[hidden], [aria-hidden="true"]') && !inQuote(el.parentElement, scope));
  }

  function detailChain(article, routeId, limit = maxAncestors) {
    if (!validStatus(routeId) || articleId(article) !== routeId || article.closest(DIALOG)) return null;
    const list = conversationList(article);
    if (!list) return null;
    const chain = [], seen = new Set([routeId]);
    let child = article;
    while (chain.length < limit) {
      const childRow = child.closest(cellSelector) || child;
      if (!list.contains(childRow)) break;
      const linked = parentIdOf(child);
      if (linked === null) break;
      let parent;
      if (linked) {
        const matches = topArticles(list).filter(el => articleId(el) === linked && beforeEditor(el, child));
        if (matches.length !== 1) break;
        parent = matches[0];
      } else {
        let row = childRow.previousElementSibling;
        while (row?.matches('[hidden], [aria-hidden="true"]')) row = row.previousElementSibling;
        if (!row) return {ancestors:chain, complete:!replyRecipient(child)};
        if (row.matches(threadBoundary) || row.querySelector(threadBoundary)) break;
        const posts = row.matches(ARTICLE) ? [row] : topArticles(row);
        if (posts.length !== 1) break;
        parent = posts[0];
      }
      const id = articleId(parent);
      if (!id || seen.has(id) || BigInt(id) >= BigInt(articleId(child))) break;
      const post = threadPost(parent);
      if (!post) break;
      const recipient = !linked && replyRecipient(child);
      if (recipient && post.author && recipient !== post.author.toLowerCase()) break;
      seen.add(id);
      chain.unshift(post);
      child = parent;
    }
    return {ancestors:chain, complete:chain.length === limit};
  }

  function localThread(scope, directId, routeId = detailId()) {
    const empty = {ancestors:[], complete:false};
    if (!scope || !validStatus(directId)) return empty;
    const detail = detailChain(scope, routeId);
    if (detail) return detail;
    const column = scope.closest('[data-testid="primaryColumn"], main') || scope.closest(DIALOG);
    if (!column) return empty;
    // Outside the focal detail page (feed, another reply, compact dialog),
    // follow only explicit parent IDs, never the order of timeline neighbors.
    const articles = topArticles(column, scope.closest(DIALOG));
    const chain = [], seen = new Set([directId]);
    let child = scope;
    while (chain.length < maxAncestors) {
      const parentId = parentIdOf(child);
      if (!parentId || seen.has(parentId)) break;
      const matches = articles.filter(el => articleId(el) === parentId);
      if (matches.length !== 1) break;
      const parent = matches[0], post = threadPost(parent);
      if (!post) break;
      seen.add(parentId);
      chain.unshift(post);
      const prefix = detailChain(parent, routeId, maxAncestors - chain.length);
      if (prefix) return {ancestors:[...prefix.ancestors, ...chain].slice(-maxAncestors), complete:prefix.complete};
      child = parent;
    }
    return {ancestors:chain, complete:chain.length === maxAncestors};
  }

  function threadForTranslation(context, binding) {
    if (!context?.scope) return {};
    const clicked = binding.clicked;
    const quote = directQuote(context.scope) || (context.id && clicked?.id === context.id && clicked.quote);
    const attachment = quote ? {quotedPost:quote} : {};
    if (!validStatus(context.id)) return attachment;
    const live = localThread(context.scope, context.id);
    const saved = clicked?.id === context.id ? clicked.thread : null;
    const chain = saved && (saved.complete || saved.ancestors.length > live.ancestors.length) ? saved : live;
    return {...attachment, ...(chain.ancestors.length ? {ancestors:chain.ancestors} : {}),
      ...(!chain.complete ? {lookupStatusId:context.id} : {})};
  }

  globalThis.chrome?.runtime?.onMessage?.addListener((request, sender, reply) => {
    if (request?.action !== "readAncestors" || sender.id !== chrome.runtime.id) return false;
    const id = request.statusId;
    if (!validStatus(id) || detailId() !== id) {
      reply({ready:false, ancestors:[]});
      return false;
    }
    const column = document.querySelector('[data-testid="primaryColumn"], main');
    const focal = column && topArticles(column).filter(article => articleId(article) === id);
    const chain = focal?.length === 1 ? localThread(focal[0], id, id) : null;
    reply({ready:Boolean(chain && (conversationList(focal[0]) || chain.ancestors.length)),
      complete:Boolean(chain?.complete), ancestors:chain?.ancestors || []});
    return false;
  });

  document.addEventListener("click", event => {
    if (!event.isTrusted) return;
    const reply = event.target.closest?.('[data-testid="reply"]');
    const article = reply?.closest(ARTICLE);
    // Capture X's source language before opening a modal potentially strips
    // the attribution. The actual post and draft are read at translation time.
    if (article) {
      const body = ownedText(article);
      const embedded = embeddedAttribution(body);
      const id = articleId(article);
      pendingReply = {article, id, thread:localThread(article, id), quote:directQuote(article), source:originalLanguage(body, embedded, article),
        post:readText(body, embedded?.bar).trim(), created:performance.now(), existing:new Set(document.querySelectorAll(EDITOR))};
    } else {
      pendingReply = null;
    }
    if (article) queueScan();
  }, true);

  function beforeEditor(element, editor) {
    return !element.contains(editor) && !editor.contains(element) &&
      Boolean(element.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function replyRecipientLines(scope, editor) {
    // Some compact compose layouts expose neither a tweet article nor tweetText.
    // Match the explicit reply recipient to its preceding author header. This
    // prevents a quoted post attached to a new draft being used as a reply.
    const ignored = TEXT + ', ' + ARTICLE + ', ' + QUOTE + ', [contenteditable], [data-xreply-translator], [hidden], [aria-hidden="true"]';
    const recipients = new Set();
    for (const el of scope.querySelectorAll('button, [role="button"], a[href], span')) {
      if (!beforeEditor(el, editor) || el.closest(ignored)) continue;
      for (const line of [el, el.parentElement]) {
        if (!line || line.textContent.length > 160 || line.closest(ignored)) continue;
        const handle = line.textContent.trim().match(/^(?:回复(?:给)?|回覆(?:給)?|replying to)\s*(@[A-Za-z0-9_]{1,15})(?:\s*(?:[,、，]|和|及|与|與|and)\s*@[A-Za-z0-9_]{1,15})*$/i)?.[1];
        if (handle) recipients.add(line);
      }
    }
    return [...recipients].filter(el => ![...recipients].some(other => other !== el && el.contains(other)));
  }

  function compactPreview(scope, editor, line) {
    const handle = line.textContent.match(/@[A-Za-z0-9_]+/)[0].toLowerCase();
    for (let branch = line; branch && branch !== scope; branch = branch.parentElement) {
      for (let candidate = branch.previousElementSibling; candidate; candidate = candidate.previousElementSibling) {
        if (candidate.matches(QUOTE) || candidate.closest('[hidden], [aria-hidden="true"]')) continue;
        const ownsAuthor = [...candidate.querySelectorAll('span, a[href]')].some(el =>
          el.textContent.trim().toLowerCase() === handle && !el.closest(TEXT + ', [contenteditable]') && !inQuote(el, candidate));
        if (ownsAuthor) return {scope:candidate, node:ownedText(candidate), author:handle};
      }
      if (branch.parentElement?.contains(editor)) break;
    }
    return null;
  }

  // null means a reply whose parent could not be identified. Only a new post
  // may use the configured target when the author leaves the choice automatic.
  const standalonePost = Object.freeze({standalone:true});

  function hasReplyControls(scope, editor, submit) {
    const replyLabel = /^(?:reply|回复|回覆|返信|답글|répondre|responder|antworten|rispondi)$/i;
    if ([submit?.textContent, submit?.getAttribute("aria-label")].some(label => replyLabel.test(label?.trim()))) return true;
    const markers = TEXT + ', ' + AUTHOR + ', [data-testid="replyingTo"], [data-testid="inReplyTo"]';
    return [...scope.querySelectorAll(markers)].some(el =>
      beforeEditor(el, editor) && !inQuote(el, scope) && !el.closest('[hidden], [aria-hidden="true"]'));
  }

  function replyContext(editor, binding) {
    const dialog = editor.closest(DIALOG);
    const composePage = !dialog && /^\/(?:compose|intent)\/(?:post|tweet)\/?$/.test(location.pathname);
    const compose = dialog || (composePage && (editor.closest('[data-testid="primaryColumn"], main') || document.body));
    const replyParam = /[?&](?:in_reply_to(?:_status_id)?|reply_to)=\d+/.test(location.search);
    const clicked = binding?.clicked;
    const clickedId = clicked?.id;
    const fromArticle = article => contextOf(ownedText(article), binding, article);
    const currentId = clicked ? articleId(clicked.article) : "";
    // A virtualized feed can reuse the same live article node for an entirely new post.
    const capturedArticle = clicked && ((clickedId && currentId === clickedId) || (!clickedId && !currentId && !clicked.article.isConnected))
      ? clicked.article : null;
    if (compose) {
      const articles = [...compose.querySelectorAll(ARTICLE)].filter(article =>
        article.closest(DIALOG) === dialog && !inQuote(article.parentElement, compose) && beforeEditor(article, editor)
      );
      // A confirmed reply recipient can identify an untagged outer preview
      // even if its embedded quote is the only semantic article on the page.
      const recipients = replyRecipientLines(compose, editor);
      const preview = recipients.length === 1 && compactPreview(compose, editor, recipients[0]);
      if (preview) {
        const context = contextOf(preview.node, binding, preview.scope);
        return context && {...context, author:preview.author};
      }
      // A reused dialog can now show a different parent. Its single visible
      // outer article identifies the current reply even before X remounts the editor.
      if (dialog && articles.length === 1) return fromArticle(articles[0]);
      if (clickedId) {
        const matches = articles.filter(article => articleId(article) === clickedId);
        if (matches.length === 1) return fromArticle(matches[0]);
        if (articles.some(article => articleId(article))) return null;
      }
      // An outer tweet article has well-defined ownership even when it contains
      // another article or a post-shaped button for the quote.
      if (dialog && articles.length) return null;
      if (capturedArticle) return fromArticle(capturedArticle);
      if (dialog && clicked) {
        const nodes = [...dialog.querySelectorAll(TEXT)].filter(el =>
          beforeEditor(el, editor) && el.closest(DIALOG) === dialog && !inQuote(el, dialog));
        if (nodes.length === 1) return contextOf(nodes[0], binding, nodes[0].parentElement);
      }
      const submit = compose.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
      if (clicked || replyParam || recipients.length || articles.length || hasReplyControls(compose, editor, submit)) return null;
      return standalonePost;
    }
    if (capturedArticle) return fromArticle(capturedArticle);
    const id = statusId(location.pathname);
    if (!id) {
      const scope = binding?.composerScope || editor.parentElement;
      if (clicked || replyParam || editor.closest(ARTICLE) || hasReplyControls(scope, editor, binding?.measuredButton) ||
          replyRecipientLines(scope, editor).length) return null;
      return standalonePost;
    }
    const column = editor.closest('[data-testid="primaryColumn"], main') || document;
    const articles = [...column.querySelectorAll(ARTICLE)].filter(article =>
      !article.closest(DIALOG) && !article.parentElement.closest(ARTICLE + ', ' + QUOTE) && articleId(article) === id
    );
    return articles.length === 1 ? fromArticle(articles[0]) : null;
  }

  const editorSettled = () => new Promise(resolve => setTimeout(resolve, 40));

  const scriptedEdits = new WeakSet();
  let writtenReply = null, writeEpoch = 0, pendingRead = null;

  async function writtenReplyMessage(operation, fields = {}) {
    try { return await chrome.runtime.sendMessage({action:"writtenReply", operation, ...fields}); }
    catch { return {}; }
  }
  function readWrittenReply() {
    if (!globalThis.chrome?.runtime?.id) return;
    const epoch = ++writeEpoch;
    writtenReply = null;
    const read = pendingRead = writtenReplyMessage("read");
    read.then(result => {
      if (pendingRead === read) pendingRead = null;
      if (writeEpoch !== epoch) return;
      writtenReply = result?.record;
      if (writtenReply) queueScan();
    });
  }
  function forgetWrittenReply() {
    const known = writtenReply;
    const read = pendingRead;
    writeEpoch++;
    writtenReply = pendingRead = null;
    if (known) void writtenReplyMessage("forget", {token:known.token});
    else if (read) void read.then(result => result?.record && writtenReplyMessage("forget", {token:result.record.token}));
  }
  async function textDigest(text) {
    const bytes = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
  }
  function replyIdentity(context) {
    if (!context?.scope) return null;
    const {scope} = context;
    const id = validStatus(context.id) ? context.id : "";
    const author = context.author || (threadPost(scope)?.author || "").toLowerCase();
    const times = [...scope.querySelectorAll("time[datetime]")].filter(el => !inQuote(el, scope));
    const timestamp = times.length === 1 ? times[0].dateTime : "";
    return id || author ? {id, author, timestamp:/^[\dTZ:.+-]{10,32}$/.test(timestamp) ? timestamp : ""} : null;
  }
  function differentReply(a, b) {
    if (!a || !b) return false;
    if (a.id && b.id) return a.id !== b.id;
    if (!a.author || !b.author) return false;
    return a.author !== b.author || Boolean(a.timestamp && b.timestamp && a.timestamp !== b.timestamp);
  }
  async function rememberWrittenReply(owner, text) {
    if (!globalThis.chrome?.runtime?.id) return;
    if (!owner) { forgetWrittenReply(); return; }
    const epoch = ++writeEpoch;
    writtenReply = null;
    const digest = await textDigest(text);
    if (epoch !== writeEpoch) return;
    const record = {...owner, token:crypto.randomUUID(), digest, length:text.length};
    writtenReply = record;
    await writtenReplyMessage("remember", {record});
    if (epoch === writeEpoch) queueScan();
  }
  // Once the person writes or opens a saved draft, identical wording is theirs.
  // X resetting the editor after submission is a programmatic change.
  function userDraftEdit(event) {
    if (!event.isTrusted) return;
    const editor = event.target.closest?.(EDITOR);
    if (editor && !scriptedEdits.has(editor)) forgetWrittenReply();
  }
  for (const type of ["beforeinput", "input", "paste", "cut", "drop", "compositionstart"]) {
    document.addEventListener(type, userDraftEdit, true);
  }
  document.addEventListener("click", event => {
    if (!event.isTrusted) return;
    const control = event.target.closest?.('button, a, [role="button"], [role="menuitem"]');
    if (control && (control.closest('[data-testid*="draft" i], a[href*="/drafts"]') ||
        /^(?:草稿(?:箱)?|儲存草稿|保存草稿|drafts|save draft)$/i.test(control.textContent.trim()))) forgetWrittenReply();
  }, true);
  window.addEventListener("pageshow", event => { if (event.persisted) readWrittenReply(); });

  function fullySelected(editor, expected) {
    const selection = editor.ownerDocument.getSelection();
    if (editor.ownerDocument.activeElement !== editor || selection?.rangeCount !== 1 || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return false;
    if (range.toString() === expected || selection.toString() === expected) return true;
    // Chrome omits image-backed emoji from Selection.toString().
    const selected = editor.cloneNode(false);
    selected.append(range.cloneContents());
    return draftOf(selected) === expected;
  }

  function syncDraftSelection(editor) {
    const doc = editor.ownerDocument;
    const event = new KeyboardEvent("keyup", {key:"Shift", code:"ShiftLeft", bubbles:true});
    if (doc.getSelection()?.isCollapsed !== false) {
      editor.dispatchEvent(event);
      return;
    }
    // Draft's React root needs the selection update. X's document-level
    // keyup handler would also open a formatting portal for our temporary range.
    const stopAtBody = incoming => { if (incoming === event) incoming.stopPropagation(); };
    doc.body.addEventListener("keyup", stopAtBody);
    try { editor.dispatchEvent(event); }
    finally { doc.body.removeEventListener("keyup", stopAtBody); }
  }

  function selectContents(editor, expected) {
    const doc = editor.ownerDocument;
    editor.focus({preventScroll:true});
    if (doc.activeElement !== editor) return false;
    const leaves = editor.querySelectorAll('[data-text="true"]');
    const first = leaves[0]?.firstChild, last = leaves[leaves.length - 1]?.lastChild;
    if (first?.nodeType === Node.TEXT_NODE && last?.nodeType === Node.TEXT_NODE) {
      doc.getSelection().setBaseAndExtent(first, 0, last, last.length);
    }
    if (!first || !fullySelected(editor, expected)) doc.execCommand("selectAll", false);
    if (!fullySelected(editor, expected)) return false;
    syncDraftSelection(editor);
    return fullySelected(editor, expected);
  }

  function pasteText(editor, text) {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const event = new ClipboardEvent("paste", {bubbles:true, cancelable:true, clipboardData:data});
    editor.dispatchEvent(event);
    return event.defaultPrevented;
  }

  function draftHistory(editor, redo = false) {
    const mac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform);
    editor.dispatchEvent(new KeyboardEvent("keydown", {key:"z", code:"KeyZ", keyCode:90, which:90,
      metaKey:mac, ctrlKey:!mac, shiftKey:redo, bubbles:true, cancelable:true}));
  }

  // null means that this is not a single, intact Draft text leaf. Keep the
  // two native edits in one JS turn so typing cannot land in the interim.
  function replaceDraftLeaf(editor, before, after, current, command) {
    const doc = editor.ownerDocument;
    const blocks = editor.querySelectorAll('[data-block="true"]');
    if (!before || !after || /[\r\n]/.test(before + after) || blocks.length !== 1 ||
        editor.querySelector('img,br,[contenteditable="false"]')) return null;
    const block = blocks[0];

    function textNodes(expected) {
      if (!current() || !editor.contains(block) || draftOf(editor) !== expected) return null;
      const nodes = [];
      const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let leaf = walker.nextNode(); leaf; leaf = walker.nextNode()) {
        if (!leaf.length) continue;
        if (!leaf.parentElement.closest('[data-text="true"]')) return null;
        nodes.push(leaf);
      }
      return nodes.map(node => node.data).join("") === expected ? nodes : null;
    }

    function select(expected, from, to) {
      const nodes = textNodes(expected);
      if (!nodes?.length) return false;
      function point(offset) {
        for (const node of nodes) {
          if (offset <= node.length) return [node, offset];
          offset -= node.length;
        }
      }
      const selection = doc.getSelection();
      selection.setBaseAndExtent(...point(from), ...point(to));
      syncDraftSelection(editor);
      return current() && draftOf(editor) === expected &&
        selection.toString() === expected.slice(from, to) && editor.contains(selection.anchorNode);
    }

    if (textNodes(before)?.length !== 1) return null;
    if (before === after) return true;
    if (!select(before, 0, 0)) return false;
    command("insertText", after);
    const combined = after + before;
    const inserted = draftOf(editor);
    if (inserted === before) return false;
    if (inserted === combined && select(combined, after.length, combined.length)) {
      command("delete");
      if (textNodes(after)?.length) return true;
    }

    // Decorators can split the inserted prefix into several React leaves.
    // Draft's undo reverts the last insertion as a model edit across them.
    // The framework can ignore the browser caret and append at the other
    // end. Only recover our known insertion when the original still matches.
    if (!current() || (inserted !== combined && inserted !== before + after) ||
        draftOf(editor) !== inserted) return false;
    draftHistory(editor);
    if (draftOf(editor) === before) return false;
    if (draftOf(editor) !== inserted) draftHistory(editor, true);
    const start = inserted === combined ? 0 : before.length;
    for (const operation of ["delete", "forwardDelete"]) {
      if (textNodes(inserted)?.length !== 1 || !select(inserted, start, start + after.length)) break;
      command(operation);
      if (draftOf(editor) === before) return false;
    }
    return false;
  }

  async function replaceText(editor, before, after) {
    if (!editor.isConnected || draftOf(editor) !== before) return false;
    const draftEditor = editor.matches(".public-DraftEditor-content") || Boolean(editor.closest(".DraftEditor-root"));
    // Earlier versions could leave a naked text node where React owns a
    // Draft leaf. A paste into that old buffer can change only the hidden
    // model. Preserve it and let the existing copy fallback handle the result.
    if (draftEditor && [...editor.querySelectorAll(".public-DraftStyleDefault-block")].some(block =>
      [...block.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.length))) return false;
    if (after === before) return true;
    const doc = editor.ownerDocument;
    const events = new AbortController();
    let interrupted = false;
    let ownCommand = false;
    let nativeInsertion = false;
    function current() {
      return !interrupted && editor.isConnected && doc.activeElement === editor;
    }
    // X shows its formatting toolbar for a nonempty editor selection. Finish
    // every scripted selection and edit in the same task, before X can paint.
    function finishSelection() {
      if (!current()) return;
      const selection = doc.getSelection();
      if (!selection?.rangeCount || !editor.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
      if (!selection.isCollapsed) selection.collapseToEnd();
      syncDraftSelection(editor);
    }
    function editSelection(edit) {
      try { return edit(); }
      finally { finishSelection(); }
    }
    function replaceContents(edit) {
      return editSelection(() => {
        if (!selectContents(editor, before) || !current() || draftOf(editor) !== before) return false;
        edit();
        return true;
      });
    }
    function command(name, value) {
      ownCommand = true;
      scriptedEdits.add(editor);
      try { return doc.execCommand(name, false, value); }
      finally { ownCommand = false; scriptedEdits.delete(editor); }
    }
    function interrupt(event) {
      if (ownCommand && event.type === "input" && event.isTrusted && editor.contains(event.target) &&
          event.inputType === "insertText") nativeInsertion = true;
      if (event.isTrusted && !ownCommand) interrupted = true;
    }
    async function restoreAppend(value, draftHandled) {
      if (!current() || value === before) return;
      if (draftHandled) {
        // A stale Draft selection can insert or replace a fragment anywhere
        // within the old text. Undo only a change consistent with this paste.
        const kept = value.length - after.length;
        if (kept < 0 || kept > before.length) return;
        let left = 0, right = 0;
        while (left < kept && before[left] === value[left]) left++;
        while (right < kept && before.at(-1 - right) === value.at(-1 - right)) right++;
        const at = value.indexOf(after, kept - right);
        if (at === -1 || at > left) return;
        // A handled paste is one Draft history entry. Keep React's text
        // leaves attached by letting Draft revert that entry itself.
        editSelection(() => draftHistory(editor));
        await editorSettled();
        return;
      }
      if (value !== before + after && value !== after + before) return;
      // Restore only the exact characters inserted by this operation. Deleting
      // this range avoids potentially coalesced native typing history.
      const leaves = doc.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      const leaf = leaves.nextNode();
      if (leaf && !leaves.nextNode() && leaf.data === value) {
        const start = value === before + after ? before.length : 0;
        const attempted = editSelection(() => {
          const selection = doc.getSelection();
          selection.setBaseAndExtent(leaf, start, leaf, start + after.length);
          if (selection.toString() !== after || !current() || draftOf(editor) !== value) return false;
          command("delete");
          return true;
        });
        if (!attempted) return;
        await editorSettled();
        if (!current() || draftOf(editor) !== value) return;
      }
      if (nativeInsertion) {
        editSelection(() => command("undo"));
      }
      await editorSettled();
    }
    for (const type of ["keydown", "pointerdown", "compositionstart", "beforeinput", "input", "paste", "cut", "drop"]) {
      doc.addEventListener(type, interrupt, {capture:true, signal:events.signal});
    }
    try {
      const block = editor.querySelector('[data-block="true"]');
      if (!after) {
        if (!replaceContents(() => {
          if (draftEditor) {
            editor.dispatchEvent(new KeyboardEvent("keydown", {key:"Backspace", code:"Backspace", keyCode:8, which:8,
              bubbles:true, cancelable:true}));
          } else command("delete");
        })) return false;
        await editorSettled();
        if (!current()) return false;
        const remaining = draftOf(editor);
        if (!remaining) return true;
        if (draftEditor && remaining !== before) editSelection(() => draftHistory(editor));
        return false;
      }
      // Even one plain word lives in React-owned leaves. Native insertText
      // can detach them while leaving identical visible and model text.
      if (!draftEditor && !block) {
        if (!replaceContents(() => command("insertText", after))) return false;
        await editorSettled();
        if (!current()) return false;
        const value = draftOf(editor);
        if (value === after) return true;
        if (value !== before) {
          await restoreAppend(value, false);
          return false;
        }
      }

      let handledPaste;
      if (!replaceContents(() => {
        ownCommand = true;
        try { handledPaste = pasteText(editor, after); }
        finally { ownCommand = false; }
      })) return false;
      await editorSettled();
      if (!current()) return false;
      const value = draftOf(editor);
      if (value === after) return true;
      if (!draftEditor && !handledPaste && value === before) {
        // An uncontrolled contenteditable with block-like markup ignores paste.
        if (!replaceContents(() => command("insertText", after))) return false;
        await editorSettled();
        if (!current()) return false;
        const inserted = draftOf(editor);
        if (inserted === after) return true;
        await restoreAppend(inserted, false);
      } else {
        await restoreAppend(value, Boolean(handledPaste && (draftEditor || block)));
        // X can keep its previous model selection even while Chrome shows the
        // whole draft selected. Use partial edits only after the original is
        // intact again, with no user action since the click.
        if (draftEditor && current() && draftOf(editor) === before &&
            editSelection(() => replaceDraftLeaf(editor, before, after, current, command))) {
          await editorSettled();
          return current() && draftOf(editor) === after;
        }
      }
      return false;
    } finally {
      events.abort();
    }
  }

  function node(tag, label, attrs = {}) {
    const el = document.createElement(tag);
    if (label) el.textContent = label;
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  }

  const settingsScopes = new WeakMap();
  const widgetOwners = new WeakMap();

  // React's capture-phase handlers run before shadow-root bubble handlers.
  // These low-level presses are not needed for our click-driven buttons.
  function isolateButtonPress(event) {
    const origin = event.composedPath()[0];
    const button = origin?.closest?.("button");
    if (!button || !widgetOwners.has(button.getRootNode().host)) return;
    // Let a Translate click move focus and commit the active IME candidate.
    const editor = widgetOwners.get(button.getRootNode().host);
    if (event.button === 0 && !(button.dataset.action === "translate" && bindings.get(editor)?.composing)) event.preventDefault();
    event.stopPropagation();
  }
  document.addEventListener("pointerdown", isolateButtonPress, true);
  document.addEventListener("mousedown", isolateButtonPress, true);

  function composerSettings(editor, host) {
    const scope = editor.closest('[role="dialog"], [aria-modal="true"]') ||
      editor.closest('[data-testid="primaryColumn"], main') || editor.parentElement;
    let record = settingsScopes.get(scope);
    if (!record || record.path !== location.pathname) {
      record = {path: location.pathname, slots: new Map()};
      settingsScopes.set(scope, record);
    }
    const slot = editor.closest('[data-testid^="tweetTextarea_"]')?.getAttribute("data-testid") || "";
    const previous = record.slots.get(slot);
    let settings = {target: "auto", tone: "natural", custom: "", expanded: false};
    const oldEditor = previous?.editor.deref();
    const replaced = oldEditor && !oldEditor.isConnected ? bindings.get(oldEditor) : null;
    if (previous && !oldEditor?.isConnected) {
      // X can rebuild just the contenteditable while its composer remains open.
      previous.host.deref()?.remove();
      settings = previous.settings;
    }
    record.slots.set(slot, {editor: new WeakRef(editor), host: new WeakRef(host), settings});
    return {settings, replaced};
  }

  function choiceGroup(field, label, choices, settings) {
    const element = node("fieldset", "", {"data-field": field});
    element.append(node("legend", label));
    const list = node("div", "", {class:"choices"});
    element.append(list);
    const controls = new Map();
    function render() {
      for (const [value, button] of controls) {
        const selected = settings[field] === value;
        button.setAttribute("aria-pressed", String(selected));
        button.tabIndex = selected ? 0 : -1;
      }
    }
    function choose(value) {
      settings[field] = value;
      render();
      element.dispatchEvent(new Event("change"));
    }
    for (const [value, text] of choices) {
      const button = node("button", text, {type:"button", "data-value":value});
      controls.set(value, button);
      list.append(button);
      button.addEventListener("click", () => choose(value));
    }
    list.addEventListener("keydown", event => {
      const index = choices.findIndex(([value]) => controls.get(value) === event.target);
      if (index < 0) return;
      let next;
      switch (event.key) {
        case "ArrowLeft": case "ArrowUp": next = (index + choices.length - 1) % choices.length; break;
        case "ArrowRight": case "ArrowDown": next = (index + 1) % choices.length; break;
        case "Home": next = 0; break;
        case "End": next = choices.length - 1; break;
        default: return;
      }
      event.preventDefault();
      const value = choices[next][0];
      controls.get(value).focus({preventScroll:true});
      choose(value);
    });
    render();
    return {element, get value() { return settings[field]; },
      focus() { controls.get(settings[field])?.focus({preventScroll:true}); }};
  }

  function canonicalLanguage(value) {
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(value)) return "";
    try { return Intl.getCanonicalLocales(value)[0]; } catch { return ""; }
  }

  // Compare with the first adopted wording so many small deletions cannot
  // gradually turn an unrelated draft into a revision of this translation.
  function isTranslationTweak(adopted, edited) {
    if (!edited.trim()) return false;
    if (adopted === edited) return true;
    function comparable(text) {
      return text.normalize("NFKC").toLowerCase()
        .replace(/https?:\/\/[^\s]+|@[a-z0-9_]+/gi, " ")
        .replace(/\p{P}/gu, "").replace(/\s+/gu, " ").trim();
    }
    const before = comparable(adopted);
    const after = comparable(edited);
    if (before === after) return true;
    if (!before || !after) return false;

    const a = Array.from(before), b = Array.from(after);
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    let left = 0, right = 0;
    while (left < shorter && a[left] === b[left]) left++;
    while (right < shorter - left && a[a.length - 1 - right] === b[b.length - 1 - right]) right++;
    // Most typing changes one contiguous piece, even in very long posts.
    if (left + right >= longer * 0.55 || (shorter >= 2 && longer - left - right <= 1)) return true;
    if (shorter < longer * 0.5 || shorter < 3) return false;

    // Dispersed edits can preserve most of the wording without sharing long
    // ends. Count overlapping runs once each, including duplicates.
    const width = shorter < 24 ? 2 : 4;
    const runs = new Map();
    for (let i = 0; i <= a.length - width; i++) {
      const run = a.slice(i, i + width).join("");
      runs.set(run, (runs.get(run) || 0) + 1);
    }
    let matches = 0;
    for (let i = 0; i <= b.length - width; i++) {
      const run = b.slice(i, i + width).join("");
      const count = runs.get(run) || 0;
      if (count) {
        matches++;
        runs.set(run, count - 1);
      }
    }
    return matches >= (longer - width + 1) * 0.5;
  }

  async function detectLocalLanguage(text) {
    if (!text?.trim()) return "";
    const sample = text.slice(0, 2048);
    try {
      const result = await chrome.i18n?.detectLanguage(sample);
      if (result?.isReliable) {
        const [top] = [...result.languages].sort((a, b) => b.percentage - a.percentage);
        const tag = canonicalLanguage(top?.language || "");
        if (tag && !unknownLanguage.test(tag) && top.percentage >= 60) return tag;
      }
    } catch { /* Some Chrome versions have no usable local result. */ }
    try {
      const result = await chrome.runtime.sendMessage({action:"detectEditLanguage", text:sample});
      const tag = result?.ok && canonicalLanguage(result.language || "");
      return tag && !unknownLanguage.test(tag) ? tag : "";
    } catch { return ""; }
  }

  const words = new Intl.Segmenter(undefined, {granularity:"word"});
  function editWords(text) {
    const prose = text.normalize("NFKC").replace(/https?:\/\/\S+|@[a-z0-9_]+/gi, " ");
    // Words inside a quotation can be in a different language from the reply.
    const outsideQuotes = prose.replace(/"[^"]+"|“[^”]+”|«[^»]+»|「[^」]+」|『[^』]+』/gu, " ");
    const ownWords = /\p{L}/u.test(outsideQuotes) ? outsideQuotes : prose;
    const result = [];
    for (const {segment, isWordLike} of words.segment(ownWords)) {
      if (isWordLike && /\p{L}/u.test(segment)) result.push(segment);
    }
    return result;
  }

  // Ignore unchanged names and links when deciding which language the person is
  // now writing in. Keep small insertions and single borrowed words in review.
  async function resumedSourceDraft(saved) {
    const sourceTag = saved.sourceLanguage || await detectLocalLanguage(saved.sourceSample);
    const source = sourceTag?.split("-")[0];
    if (!source || unknownLanguage.test(source)) return false;
    saved.sourceLanguage = sourceTag;
    const previous = editWords(saved.adopted), current = editWords(saved.text);
    const sameWord = (a, b) => a.toLowerCase() === b.toLowerCase();
    const size = Math.min(previous.length, current.length);
    let head = 0, tail = 0;
    while (head < size && sameWord(previous[head], current[head])) head++;
    while (tail < size - head && sameWord(previous.at(-1-tail), current.at(-1-tail))) tail++;
    const added = current.slice(head, current.length-tail);
    if (!added.length) return false;
    const targetTag = saved.targetLanguage || await detectLocalLanguage(saved.adopted);
    const target = targetTag?.split("-")[0];
    if (!target || source === target || unknownLanguage.test(target)) return false;
    saved.targetLanguage = targetTag;
    if (saved.originalWording && saved.text.trim() === saved.originalWording.trim()) return true;
    if (added.length < 2) return false;
    const addition = added.join(" ");
    const addedLang = (await detectLocalLanguage(addition)).split("-")[0];
    if (addedLang !== source) return false;
    if (added.length * 2 >= current.length) return true;
    // A substantial replacement can switch languages even when a long proper
    // name dominates the detector's reading of the full sentence.
    const removed = previous.slice(head, previous.length-tail);
    if ((head < 2 || tail < 2) && added.length >= 3 && removed.length >= 3 &&
        (await detectLocalLanguage(removed.join(" "))).split("-")[0] === target) return true;
    return (await detectLocalLanguage(saved.text)).split("-")[0] === source;
  }

  function makeWidget(editor) {
    const host = node("div", "", {"data-xreply-translator":"", "data-xreply-version":VERSION});
    const actions = node("div", "", {"data-xreply-actions":"", "data-xreply-version":VERSION});
    const shadow = host.attachShadow({mode: "open"});
    const actionShadow = actions.attachShadow({mode:"open"});
    widgetOwners.set(host, editor);
    widgetOwners.set(actions, editor);
    const {settings, replaced} = composerSettings(editor, host);
    const binding = {host, actions, clicked:null, revision:0, busy:false, composing:false, undo:null};
    const style = node("style");
    style.textContent = [
      ':host { display:block; min-width:0; color:inherit; font:13px/1.45 system-ui,sans-serif; }',
      '[hidden] { display:none !important; } .row,.choices { display:flex; align-items:center; flex-wrap:wrap; gap:5px 7px; }',
      'button,input { box-sizing:border-box; font:inherit; color:inherit; background:transparent; }',
      'button { cursor:pointer; border:1px solid #8887; border-radius:15px; padding:3px 10px; }',
      'button.primary { font-weight:650; } button:disabled { opacity:.55; cursor:wait; }',
      'button:focus-visible,input:focus-visible { outline:2px solid #1d9bf0; outline-offset:2px; }',
      '.opts { margin:7px 0; padding:6px 10px 9px; border:1px solid #8887; border-radius:9px; }',
      'fieldset { border:0; padding:0; margin:0; min-inline-size:0; } fieldset+fieldset { margin-top:7px; }',
      'legend { font-weight:600; margin-bottom:4px; padding:0; } .choices button { padding:2px 9px; }',
      'button[aria-pressed=true] { font-weight:650; border-color:currentColor; background:color-mix(in srgb,currentColor 12%,transparent); }',
      'input { width:145px; border:1px solid #8887; border-radius:5px; padding:3px 6px; margin-top:4px; }',
      '.message { margin:4px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; } .message:empty { display:none; }',
      '[data-role="back-translation"][aria-busy="true"] { opacity:.55; }',
      'textarea { width:100%; box-sizing:border-box; font:inherit; }'
    ].join("\n");
    const actionStyle = node("style");
    actionStyle.textContent = [
      ':host { display:inline-flex; align-self:center; flex:0 0 auto; margin-inline:4px; vertical-align:middle; height:32px; color:inherit; font:600 15px/1.2 system-ui,sans-serif; }',
      '.actions { display:inline-flex; align-items:stretch; height:100%; box-shadow:inset 0 0 0 1px #8888; border-radius:999px; white-space:nowrap; }',
      'button { display:inline-flex; align-items:center; justify-content:center; font:inherit; letter-spacing:inherit; color:inherit; cursor:pointer; background:transparent; border:0; padding:0; }',
      'button:hover { background:color-mix(in srgb,currentColor 9%,transparent); } button:focus-visible { outline:2px solid #1d9bf0; outline-offset:1px; }',
      'button:disabled { opacity:.55; cursor:wait; } [data-action=translate] { padding-inline:14px 3px; border-radius:999px 0 0 999px; }',
      '[data-action=settings] { width:1.6em; border-radius:0 999px 999px 0; }',
      '[data-action=settings]::before { content:""; border:.28em solid transparent; border-bottom:0; border-top:.34em solid currentColor; }',
      '[data-action=settings][aria-expanded=true]::before { transform:rotate(180deg); }'
    ].join("\n");
    const row = node("div", "", {class: "row"});
    const translate = node("button", "翻译", {type: "button", class: "primary", "data-action": "translate"});
    const undo = node("button", "撤销翻译", {type: "button", hidden: "", "data-action": "undo"});
    const summary = node("button", "", {type:"button", "data-action":"settings", "aria-label":"语言与语气", title:"语言与语气"});
    if ("ariaControlsElements" in summary) summary.ariaControlsElements = [host];
    const opts = node("div", "", {class:"opts", id:"settings-panel", "data-panel":"settings"});
    const target = choiceGroup("target", "目标语言", [
      ["auto","跟随原帖语言"],["en","英语"],["ja","日语"],["ko","韩语"],["es","西班牙语"],
      ["fr","法语"],["de","德语"],["pt","葡萄牙语"],["it","意大利语"],["ru","俄语"],
      ["ar","阿拉伯语"],["hi","印地语"],["zh-Hans","简体中文"],["zh-Hant","繁体中文"],["custom","其他语言…"]
    ], settings);
    const custom = node("input", "", {placeholder:"例如 nl 或 pt-BR", "aria-label":"目标语言代码", maxlength:"35", spellcheck:"false"});
    custom.value = settings.custom;
    custom.hidden = target.value !== "custom";
    custom.addEventListener("input", () => { settings.custom = custom.value; });
    const preview = node("span", "", {"data-role":"source-preview"});
    target.element.querySelector('[data-value="auto"]').append(preview);
    target.element.append(custom);
    const tone = choiceGroup("tone", "语气", [["natural","自然口语"],["friendly","更友好"],["polite","更客气"]], settings);
    opts.append(target.element, tone.element);
    const actionRow = node("div", "", {class:"actions"});
    actionRow.append(translate, summary);
    actionShadow.append(actionStyle, actionRow);
    const restoreDraft = node("button", "恢复上条回复的译文", {type:"button", hidden:""});
    row.append(undo, restoreDraft);
    const message = node("div", "", {class:"message", role:"status", "aria-live":"polite"});
    const fallback = node("textarea", "", {hidden:"", readonly:"", rows:"3", "aria-label":"可手动复制的译文"});
    shadow.append(style, row, opts, message, fallback);
    const checkLine = node("div", "", {"data-role":"back-translation", "aria-live":"polite", hidden:""});
    const retryCheck = node("button", "重试回译", {type:"button", hidden:""});
    checkLine.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0";
    message.after(checkLine, retryCheck);
    let checkedResult = null;
    let checkTimer = 0;
    const checkDelay = 750;
    let previousResult = null;
    let pendingTranslation = null;

    function releasePreviousResult() {
      if (!previousResult) return;
      previousResult.observer.disconnect();
      previousResult.buttonSlot.replaceWith(undo);
      previousResult.lineSlot.replaceWith(checkLine);
      previousResult = null;
    }

    // An open composer keeps the exact original draft in its old undo
    // handler. Its displayed back-translation also gives us an original-language
    // sample for checking edits made after the extension has been updated.
    binding.adoptPreviousResult = oldHost => {
      const old = oldHost?.shadowRoot;
      const button = old?.querySelector('[data-action="undo"]:not([hidden]):not(:disabled)');
      const line = old?.querySelector('[data-role="back-translation"]:not([hidden])');
      const copy = old?.querySelector('textarea[readonly]');
      if (!line?.textContent.startsWith("回译：") || line.getAttribute("aria-busy") === "true" || !copy?.hidden) return;
      if (!button && !["1.0.8","1.0.9","1.0.10","1.0.11","1.1.0","1.1.1","1.2.0","1.2.1"].includes(oldHost.dataset.xreplyVersion)) return;
      const text = draftOf(editor);
      if (!text.trim()) return;
      const context = replyContext(editor, binding);
      const sameReply = matchReply(context, "auto");
      checkedResult = {text, adopted:text, sameReply, finished:true,
        sourceSample:line.textContent.slice("回译：".length).trim(), edited:!button};
      if (!button) {
        // The earlier widget already retired its undo button after a manual edit.
        checkLine.textContent = line.textContent;
        checkLine.hidden = false;
        return;
      }
      // A previous version may itself have inherited these nodes. Its cleanup
      // can replace them, so retain our own stable insertion points.
      const buttonSlot = node("span"), lineSlot = node("div");
      undo.replaceWith(buttonSlot);
      checkLine.replaceWith(lineSlot);
      buttonSlot.append(button);
      lineSlot.append(line);
      const observer = new MutationObserver(() => {
        if (button.disabled) return;
        if (!copy.hidden) keepResult(old.querySelector(".message").textContent, copy.value);
        if (button.hidden || !copy.hidden) releasePreviousResult();
      });
      observer.observe(button, {attributes:true, attributeFilter:["disabled", "hidden"]});
      observer.observe(copy, {attributes:true, attributeFilter:["hidden"]});
      previousResult = {button, buttonSlot, lineSlot, observer, text};
    };

    function clearCheck() {
      clearTimeout(checkTimer);
      checkedResult = null;
      checkLine.removeAttribute("aria-busy");
      checkLine.textContent = "";
      checkLine.hidden = retryCheck.hidden = true;
    }

    function matchReply(context, selected) {
      const route = location.pathname;
      return (currentEditor, currentBinding) => {
        if (location.pathname !== route) return false;
        const current = replyContext(currentEditor, currentBinding);
        return current?.standalone === context?.standalone && (current?.post || "") === (context?.post || "") &&
          (current?.id || "") === (context?.id || "") && current?.author === context?.author &&
          (selected !== "auto" || current?.langHint === context?.langHint);
      };
    }

    function checkIsCurrent(saved) {
      return saved && checkedResult === saved && editor.isConnected && host.isConnected && !binding.composing &&
        saved.sameReply(editor, binding) && (saved.inFallback
          ? !fallback.hidden && fallback.value === saved.text && draftOf(editor) === saved.editorText
          : draftOf(editor) === saved.text);
    }

    function discardDepartedReply(saved) {
      if (saved && checkedResult === saved && !saved.sameReply(editor, binding)) {
        releasePreviousResult();
        binding.undo = null;
        undo.hidden = true;
        fallback.hidden = true;
        message.textContent = "";
        clearCheck();
      }
    }

    async function showCheck(saved) {
      if (!checkIsCurrent(saved)) {
        discardDepartedReply(saved);
        return;
      }
      if (saved.tentative || saved.pending || saved.finished) return;
      clearTimeout(checkTimer);
      saved.pending = true;
      checkLine.setAttribute("aria-busy", "true");
      retryCheck.hidden = true;
      try {
        if (saved.edited && await resumedSourceDraft(saved)) {
          if (checkIsCurrent(saved)) clearCheck();
          return;
        }
        if (!checkIsCurrent(saved)) return;
        const language = saved.sourceLanguage || await detectLocalLanguage(saved.sourceSample);
        if (!checkIsCurrent(saved)) return;
        if (!language || unknownLanguage.test(language)) throw new Error("未能识别草稿语言，无法回译。");
        saved.sourceLanguage = language;
        const result = await chrome.runtime.sendMessage({action:"backTranslate", text:saved.text, target:language});
        if (!result?.ok || typeof result.text !== "string" || !result.text.trim()) {
          throw new Error(result?.error || "未能获取回译。");
        }
        // The check lives outside the contenteditable and cannot be sent with the reply.
        if (checkIsCurrent(saved)) {
          checkLine.textContent = (saved.inFallback ? "下方译文的回译：" : "回译：") + result.text.trim();
          checkLine.hidden = false;
          saved.finished = true;
        }
      } catch (error) {
        if (!checkIsCurrent(saved)) return;
        checkLine.textContent = "回译失败。" + (error.message || "");
        checkLine.hidden = false;
        retryCheck.hidden = false;
      } finally {
        saved.pending = false;
        discardDepartedReply(saved);
        if (checkedResult === saved && !binding.composing) checkLine.removeAttribute("aria-busy");
      }
    }
    function scheduleCheck(saved) {
      clearTimeout(checkTimer);
      if (saved.tentative) {
        // Replacing a selected word sometimes crosses the similarity threshold
        // for a few keystrokes. Hide immediately and allow the word to finish.
        checkLine.hidden = retryCheck.hidden = true;
        checkTimer = setTimeout(() => { if (checkedResult === saved) clearCheck(); }, checkDelay);
        return;
      }
      // Keep the last successful check dimmed until its replacement is available.
      if (!retryCheck.hidden) checkLine.hidden = true;
      retryCheck.hidden = true;
      checkLine.setAttribute("aria-busy", "true");
      checkTimer = setTimeout(() => void showCheck(saved), checkDelay);
    }
    retryCheck.addEventListener("click", event => { if (event.isTrusted) void showCheck(checkedResult); });
    function refreshPreview() {
      preview.hidden = !settings.expanded || target.value !== "auto";
      if (!settings.expanded) return;
      const context = replyContext(editor, binding);
      preview.parentElement.firstChild.textContent = context === standalonePost ? "使用默认目标语言" : "跟随原帖语言";
      if (preview.hidden) return;
      if (context?.original) {
        let name = context.original;
        try { name = new Intl.DisplayNames(["zh-CN"], {type:"language"}).of(name) || name; } catch { /* Keep the language code. */ }
        preview.textContent = "（" + name + "）";
      } else {
        preview.textContent = "";
      }
    }
    function openSettings(open) {
      settings.expanded = open;
      opts.hidden = !open;
      summary.setAttribute("aria-expanded", String(open));
      if (open && !host.isConnected) {
        // scan() attaches the reply source and the widget after rebuilding an editor.
        queueMicrotask(refreshPreview);
      } else {
        refreshPreview();
      }
    }
    function focusLanguage() { target.focus(); }
    openSettings(settings.expanded);
    summary.addEventListener("click", event => {
      openSettings(!settings.expanded);
      if (settings.expanded && event.detail === 0) focusLanguage();
    });
    // Keep interactions with our controls out of X's reply/editor event handlers.
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "touchstart", "touchend",
      "input", "change", "focusin", "focusout", "keydown", "keyup", "compositionstart", "compositionend"]) {
      const isolate = event => {
        if (type === "keydown" && event.key === "Escape" && settings.expanded && !event.isComposing) {
          event.preventDefault();
          openSettings(false);
          summary.focus({preventScroll:true});
        }
        event.stopPropagation();
      };
      shadow.addEventListener(type, isolate);
      actionShadow.addEventListener(type, isolate);
    }
    bindings.set(editor, binding);
    let observedDraft = draftOf(editor);
    function reconcileEditor(inputEvent) {
      if (binding.composing) return;
      const text = draftOf(editor);
      if (!inputEvent && text === observedDraft) return;
      observedDraft = text;
      binding.revision++;
      binding.refreshPendingTranslation();
      const saved = checkedResult;
      const inheritedUndo = previousResult?.button.disabled && !binding.busy;
      if (previousResult && text !== previousResult.text && !inheritedUndo) releasePreviousResult();
      if (binding.undo && text !== binding.undo.text) {
        binding.undo = null;
        undo.hidden = true;
      }
      if (!saved || (saved.inFallback ? text === saved.editorText : text === saved.text)) return;
      if (inheritedUndo || !editor.isConnected || !host.isConnected || !saved.sameReply(editor, binding)) {
        clearCheck();
        return;
      }
      if (saved.inFallback) {
        // Pasting the offered result manually also adopts it.
        clearCheck();
        if (text !== saved.text) return;
        fallback.hidden = true;
        message.textContent = "";
        checkedResult = {...saved, inFallback:false, pending:false, finished:false};
        binding.undo = checkedResult;
        undo.hidden = false;
        void showCheck(checkedResult);
        return;
      }
      if (!text.trim()) {
        clearCheck();
        return;
      }
      const tentative = !isTranslationTweak(saved.adopted, text);
      checkedResult = {...saved, text, edited:true, tentative, pending:false, finished:false};
      scheduleCheck(checkedResult);
    }
    // Draft can commit paste and delete through React without a native input event.
    editor.addEventListener("input", event => { if (!event.isComposing) reconcileEditor(true); });
    new MutationObserver(() => reconcileEditor(false)).observe(editor, {childList:true, characterData:true, subtree:true});
    editor.addEventListener("compositionstart", () => {
      binding.composing = true;
      clearTimeout(checkTimer);
      if (checkedResult) checkLine.setAttribute("aria-busy", "true");
    });
    editor.addEventListener("compositionend", () => {
      binding.composing = false;
      reconcileEditor(true);
      if (checkedResult?.finished) checkLine.removeAttribute("aria-busy");
      else if (checkedResult && !checkedResult.pending) scheduleCheck(checkedResult);
    });

    // X may replace the entire editable node while keeping its composer open.
    // Transfer only a review that still belongs to the same compose context.
    binding.takeReview = () => {
      const saved = checkedResult;
      if (!saved || saved.inFallback || saved.tentative || previousResult || binding.busy) return null;
      const state = {saved, line:checkLine.textContent, visible:!checkLine.hidden && retryCheck.hidden,
        undo:binding.undo === saved, clicked:binding.clicked};
      clearCheck();
      return state;
    };
    if (replaced) {
      const prior = replaced.takeReview?.();
      if (prior) {
        binding.clicked = prior.clicked;
        const {saved} = prior;
        const context = replyContext(editor, binding);
        if ((context?.standalone || context?.id || context?.post) && saved.sameReply(editor, binding) &&
            isTranslationTweak(saved.adopted, observedDraft)) {
          const identical = observedDraft === saved.text;
          checkedResult = {...saved, text:observedDraft, edited:saved.edited || !identical, pending:false,
            finished:identical && saved.finished && prior.visible};
          if (identical && prior.undo) {
            binding.undo = checkedResult;
            undo.hidden = false;
          }
          if (prior.visible) {
            checkLine.textContent = prior.line;
            checkLine.hidden = false;
          }
          if (!checkedResult.finished) scheduleCheck(checkedResult);
        } else {
          binding.clicked = null;
        }
      }
    }

    function setBusy(value) {
      binding.busy = value;
      translate.disabled = value;
      undo.disabled = value;
      if (previousResult) previousResult.button.disabled = value;
      target.element.disabled = value;
      custom.disabled = value;
      tone.element.disabled = value;
      translate.setAttribute("aria-busy", String(value));
    }
    binding.refreshPendingTranslation = () => {
      discardDepartedReply(checkedResult);
      const pending = pendingTranslation;
      if (!pending || pending.writing) return;
      if (!pending.sameReply(editor, binding)) {
        pendingTranslation = null;
        message.textContent = "";
      } else if (binding.busy && draftOf(editor) !== pending.before) {
        message.textContent = "草稿已修改，可以重新翻译。";
      } else {
        return;
      }
      setBusy(false);
    };
    function keepResult(note, result) {
      message.textContent = note;
      fallback.value = result;
      fallback.hidden = false;
    }
    async function applyText(before, after) {
      try { return await replaceText(editor, before, after); } catch { return false; }
    }
    let comparedDraft, removedDraft;
    binding.checkCarriedDraft = () => {
      const record = writtenReply;
      const text = (record || removedDraft) && draftOf(editor);
      if (removedDraft && (text || !removedDraft.sameReply(editor, binding))) {
        restoreDraft.hidden = true;
        removedDraft = null;
      }
      if (!record || binding.busy || binding.composing || !text || text.length !== record.length ||
          editor.closest('[hidden], [aria-hidden="true"]') || !editor.getClientRects().length) return;
      const active = document.activeElement;
      if (active !== editor && (active?.matches("input, textarea, [contenteditable=true]") ||
          (active?.closest(DIALOG) && active.closest(DIALOG) !== editor.closest(DIALOG)))) return;
      // A click captured for an earlier dialog may be stale if X reuses the
      // editor. Prefer the post actually visible above this editor.
      const direct = replyContext(editor, {...binding, clicked:null});
      const context = direct?.scope ? direct : replyContext(editor, binding);
      const owner = replyIdentity(context);
      if (!differentReply(record, owner)) return;
      if (comparedDraft?.record === record && comparedDraft.text === text &&
          !differentReply(comparedDraft.owner, owner)) return;
      const comparison = comparedDraft = {record, text, owner};
      const matches = matchReply(context, "auto");
      const sameReply = (current, state) => matches(current, direct?.scope ? {...state, clicked:null} : state);
      void textDigest(text).then(async digest => {
        if (comparedDraft !== comparison || writtenReply !== record || digest !== record.digest || !editor.isConnected ||
            binding.busy || binding.composing || !sameReply(editor, binding) || draftOf(editor) !== text) return;
        setBusy(true);
        try {
          if (!await applyText(text, "") || !sameReply(editor, binding) || draftOf(editor)) return;
          binding.undo = null;
          undo.hidden = true;
          clearCheck();
          removedDraft = {text, sameReply};
          restoreDraft.hidden = false;
        } finally { setBusy(false); }
      }).catch(() => {});
    };
    restoreDraft.addEventListener("click", async event => {
      const saved = removedDraft;
      if (!event.isTrusted || !saved || binding.busy || draftOf(editor) || !saved.sameReply(editor, binding)) return;
      forgetWrittenReply();
      setBusy(true);
      try {
        // A standard, cancelable paste updates X's Draft.js submit model.
        editor.focus({preventScroll:true});
        if (!pasteText(editor, saved.text) && !draftOf(editor)) document.execCommand("insertText", false, saved.text);
        await editorSettled();
        if (draftOf(editor) !== saved.text) keepResult("可以复制上条回复的译文。", saved.text);
        restoreDraft.hidden = true;
        removedDraft = null;
      } finally { setBusy(false); }
    });
    target.element.addEventListener("change", () => {
      custom.hidden = target.value !== "custom";
      refreshPreview();
      if (!custom.hidden) custom.focus({preventScroll:true});
    });

    translate.addEventListener("click", async event => {
      if (!event.isTrusted || binding.busy) return;
      reconcileEditor(false);
      const before = draftOf(editor);
      // Automatic back-translation may classify edits as tweaks. An explicit
      // translate click always submits what the user has written.
      const previous = checkedResult;
      // Changing the target or tone of an untouched translation should still
      // start from what the person originally wrote and check in that language.
      let draft = binding.undo?.text === before && binding.undo.sameReply(editor, binding) ? binding.undo.draft : before;
      if (previous?.inFallback && previous.reuseDraft && previous.editorText === before && previous.sameReply(editor, binding)) draft = previous.draft;
      if (!draft.trim() || binding.composing) {
        message.textContent = binding.composing ? "请先完成当前输入，再翻译。" : "请先在 X 编辑框中写下草稿。";
        return;
      }
      const context = replyContext(editor, binding);
      const selected = target.value === "custom" ? canonicalLanguage(custom.value.trim()) : target.value;
      let language = selected;
      if (target.value === "auto") language = context === standalonePost ? "default" : context?.original || "auto";
      if (target.value === "custom" && unknownLanguage.test(language.split("-")[0])) language = "";
      if (!language || (language === "auto" && (!context || context.translated))) {
        openSettings(true);
        message.textContent = !language ? "请输入目标语言代码，例如 nl 或 pt-BR。"
          : context?.translated ? "X 已翻译这条帖子，但没有显示可识别的原文语言。请手动选择目标语言。"
          : "未能确定正在回复哪条帖子。请在「目标语言」中选择语言。";
        if (!language) custom.focus();
        else focusLanguage();
        return;
      }
      if (Array.from(draft).length > 35000 || Array.from(context?.post || "").length > 35000) {
        message.textContent = "草稿或原帖超过 35,000 字符，请缩短后重试。";
        return;
      }
      const revision = binding.revision;
      const sameReply = matchReply(context, selected);
      const continuing = previous && !previous.tentative && !previous.edited && previous.sameReply(editor, binding) &&
        (previous.inFallback ? previous.reuseDraft && previous.editorText === before : previous.text === before);
      const request = {before, sameReply, writing:false};
      pendingTranslation = request;
      setBusy(true);
      message.textContent = "正在翻译…";
      try {
        const result = await chrome.runtime.sendMessage({
          action:"translate", draft, post:context?.post || "", langHint:context?.langHint || "", ...threadForTranslation(context, binding),
          target:language, tone:tone.value, ...(continuing && previous.sourceLanguage ? {source:previous.sourceLanguage} : {})
        });
        if (pendingTranslation !== request || !editor.isConnected || !host.isConnected || !sameReply(editor, binding)) return;
        if (!result?.ok || typeof result.text !== "string" || !result.text.trim()) {
          throw new Error(result?.error || "未能获取译文。请检查扩展工具栏中的账号连接。");
        }
        if (binding.revision !== revision || binding.composing || draftOf(editor) !== before) {
          keepResult("草稿已改变，译文保留在下方，可手动复制。", result.text);
          return;
        }
        // Retargeting an accepted reply keeps the very first draft's check language.
        const saved = {draft, text:result.text, adopted:result.text, sameReply,
          sourceLanguage:continuing && previous.sourceLanguage || canonicalLanguage(result.sourceLanguage || ""),
          originalWording:continuing ? previous.originalWording : draft,
          targetLanguage:canonicalLanguage(result.language || "") || canonicalLanguage(language)};
        if (continuing && previous.sourceSample && !previous.sourceLanguage) {
          saved.sourceLanguage = "";
          saved.sourceSample = previous.sourceSample;
        }
        releasePreviousResult();
        clearCheck();
        fallback.hidden = true;
        request.writing = true;
        message.textContent = "";
        const owner = replyIdentity(context);
        const applied = await applyText(before, result.text);
        if (applied && before !== result.text) void rememberWrittenReply(owner, result.text);
        if (!editor.isConnected || !host.isConnected || !sameReply(editor, binding)) return;
        if (applied) {
          binding.undo = saved;
          undo.hidden = false;
        } else {
          keepResult("X 编辑框未接受替换，可手动复制下方译文。", result.text);
          saved.inFallback = true;
          saved.text = fallback.value;
          saved.editorText = draftOf(editor);
          // A user can type while X is applying an edit. Only reuse the original
          // draft when the failed write left it intact or appended the translation.
          saved.reuseDraft = [before, before + saved.text, saved.text + before].includes(saved.editorText);
        }
        checkedResult = saved;
        void showCheck(saved);
      } catch (err) {
        if (pendingTranslation === request && sameReply(editor, binding)) {
          message.textContent = err.message?.includes("context invalidated") ? "扩展已更新，请刷新 X 页面后再试。" : err.message || "无法连接 Deftly Put 的本机助手。";
        }
      } finally {
        if (pendingTranslation === request) {
          pendingTranslation = null;
          if (message.textContent === "正在翻译…") message.textContent = "";
          setBusy(false);
        }
      }
    });
    undo.addEventListener("click", async event => {
      if (!event.isTrusted) return;
      discardDepartedReply(checkedResult);
      const saved = binding.undo;
      if (binding.busy || !saved) return;
      clearCheck();
      fallback.hidden = true;
      if (draftOf(editor) !== saved.text) {
        message.textContent = "草稿已被编辑，请用 X 的撤销快捷键恢复之前的内容。";
        undo.hidden = true;
        binding.undo = null;
        return;
      }
      forgetWrittenReply();
      setBusy(true);
      try {
        if (await applyText(saved.text, saved.draft)) {
          binding.undo = null;
          undo.hidden = true;
          message.textContent = "";
        } else {
          keepResult("X 编辑框未接受撤销，可手动复制下方原草稿。", saved.draft);
        }
      } finally {
        setBusy(false);
      }
    });
    return binding;
  }

  function toolbarSlot(toolbar, submit) {
    if (!toolbar) return submit ? {row:submit.parentElement, before:submit} : null;
    if (!submit) return {row:toolbar, before:null};
    // X uses both a standalone media toolbar and a toolbar enclosing the send controls.
    const media = toolbar.contains(submit)
      ? [...toolbar.querySelectorAll('button, [role="button"], input[type="file"]')].find(el => el !== submit && !submit.contains(el))
      : toolbar;
    let row = media?.parentElement || toolbar;
    while (!row.contains(submit)) row = row.parentElement;
    // A nested control group can have its own vertical alignment and padding.
    // Share its row with Reply when doing so keeps the translation button before the counter.
    const counter = row.querySelector('[role="progressbar"], [data-testid="tweetCharacterCounter"]');
    for (let group = submit.parentElement; group && group !== row; group = group.parentElement) {
      const layout = getComputedStyle(group);
      if ((!counter || group.contains(counter)) && layout.display.includes("flex") && layout.flexDirection === "row") {
        row = group;
        break;
      }
    }
    let before = submit;
    while (before.parentElement !== row) before = before.parentElement;
    if (counter && (!media || (media.compareDocumentPosition(counter) & Node.DOCUMENT_POSITION_FOLLOWING))) {
      let counterBranch = counter;
      while (counterBranch.parentElement !== row) counterBranch = counterBranch.parentElement;
      if (!counterBranch.contains(media)) before = counterBranch;
    }
    return {row, before};
  }

  function matchReplyButton(binding, submit) {
    const {actions} = binding;
    if (binding.measuredButton === submit && binding.measuredRow === actions.parentElement) return;
    binding.stopMeasuring?.();
    binding.measuredButton = submit;
    binding.measuredRow = actions.parentElement;
    if (!submit) return;

    function update() {
      if (!submit.isConnected || !actions.isConnected || !submit.getClientRects().length) return;
      const box = getComputedStyle(submit);
      const text = document.createTreeWalker(submit, NodeFilter.SHOW_TEXT);
      let leaf;
      while ((leaf = text.nextNode())) {
        const label = leaf.parentElement;
        if (leaf.data.trim() && !label.closest('svg, [hidden], [aria-hidden="true"]') && label.getClientRects().length) break;
      }
      const type = getComputedStyle(leaf?.parentElement || submit);
      let height = parseFloat(box.height);
      if (box.boxSizing !== "border-box") {
        height += parseFloat(box.paddingTop) + parseFloat(box.paddingBottom) +
          parseFloat(box.borderTopWidth) + parseFloat(box.borderBottomWidth);
      }
      if (height > 0) actions.style.height = height + "px";
      for (const key of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"]) {
        actions.style[key] = type[key];
      }
      if (actions.parentElement === submit.parentElement) {
        actions.style.alignSelf = box.alignSelf;
        actions.style.marginBlockStart = box.marginBlockStart;
        actions.style.marginBlockEnd = box.marginBlockEnd;
      }
    }
    const sizes = new ResizeObserver(update);
    sizes.observe(submit, {box:"border-box"});
    const styles = new MutationObserver(update);
    styles.observe(submit, {attributes:true, childList:true, characterData:true, subtree:true});
    styles.observe(document.documentElement, {attributes:true, attributeFilter:["class", "style"]});
    window.addEventListener("resize", update);
    binding.stopMeasuring = () => {
      sizes.disconnect();
      styles.disconnect();
      window.removeEventListener("resize", update);
      actions.removeAttribute("style");
      binding.stopMeasuring = null;
    };
    update();
  }

  // An older content script can still move its hidden controls after an
  // unpacked update. Leave those siblings in place so a click stays attached.
  function nextVisibleSlot(node) {
    let next = node.nextElementSibling;
    while (next?.matches("[data-xreply-translator], [data-xreply-actions]") && next.dataset.xreplyVersion !== VERSION) {
      next = next.nextElementSibling;
    }
    return next;
  }

  function attach(editor, binding) {
    const {host, actions} = binding;
    let anchor = editor.closest('[data-testid^="tweetTextarea_"]') || editor;
    anchor = anchor.closest(".DraftEditor-root") || anchor;
    let branch = anchor;
    let toolbar = null, submit = null;
    binding.composerScope = editor.parentElement;
    for (let parent = branch.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.querySelectorAll(EDITOR).length !== 1) break;
      binding.composerScope = parent;
      const tools = parent.querySelector('[data-testid="toolBar"]');
      const send = parent.querySelector('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
      if (!toolbar && !submit && ((tools && !branch.contains(tools)) || (send && !branch.contains(send)))) anchor = branch;
      toolbar ||= tools;
      submit ||= send;
      if (toolbar && submit) break;
      if (parent.matches('article, [role="dialog"], main')) break;
      branch = parent;
    }
    if (binding.adoptPreviousResult) {
      // Earlier unpacked reloads may have left several hidden widget siblings.
      let previous = null;
      for (let el = anchor.nextElementSibling; el?.matches('[data-xreply-translator], [data-xreply-actions]'); el = el.nextElementSibling) {
        if (!el.hasAttribute("data-xreply-translator")) continue;
        const version = el.dataset.xreplyVersion;
        if (["1.0.3","1.0.4","1.0.5","1.0.6","1.0.7","1.0.8","1.0.9","1.0.10","1.1.0","1.1.1","1.2.0","1.2.1"].includes(version) &&
            (!previous || version.localeCompare(previous.dataset.xreplyVersion, "en", {numeric:true}) > 0)) previous = el;
      }
      binding.adoptPreviousResult(previous);
      delete binding.adoptPreviousResult;
    }
    if (nextVisibleSlot(anchor) !== host) anchor.after(host);
    const slot = toolbarSlot(toolbar, submit);
    const previous = actions.parentElement;
    if (previous && previous !== slot?.row) previous.removeAttribute("data-xreply-toolbar-row");
    if (slot) {
      if (actions.parentElement !== slot.row || nextVisibleSlot(actions) !== slot.before) {
        slot.row.insertBefore(actions, slot.before);
      }
      if (slot.row !== previous || !slot.row.hasAttribute("data-xreply-toolbar-row")) {
        const style = getComputedStyle(slot.row);
        if (style.display.includes("flex") && style.flexDirection.startsWith("row")) {
          slot.row.setAttribute("data-xreply-toolbar-row", "");
        }
      }
    } else if (nextVisibleSlot(host) !== actions) {
      host.after(actions);
    }
    matchReplyButton(binding, submit);
    binding.checkCarriedDraft();
  }

  function scan() {
    scheduled = false;
    if (rules.dataset.xreplyVersion !== VERSION) return;
    // The toolbar can outlive its editor when X closes or rebuilds a composer.
    for (const el of document.querySelectorAll('[data-xreply-actions], [data-xreply-translator]')) {
      const owner = widgetOwners.get(el);
      if (owner && !owner.isConnected) {
        bindings.get(owner)?.stopMeasuring?.();
        if (el.hasAttribute("data-xreply-actions")) el.parentElement?.removeAttribute("data-xreply-toolbar-row");
        el.remove();
      }
    }
    let clicked = pendingReply;
    if (clicked && performance.now() - clicked.created > 8500) clicked = pendingReply = null;
    for (const editor of document.querySelectorAll(EDITOR)) {
      const binding = bindings.get(editor) || makeWidget(editor);
      if (clicked && !clicked.existing.has(editor) &&
          (editor.closest('[role="dialog"], [aria-modal="true"]') || (clicked.id && statusId(location.pathname) === clicked.id))) {
        binding.clicked = clicked;
        pendingReply = clicked = null;
      }
      attach(editor, binding);
      binding.refreshPendingTranslation();
    }
  }

  function queueScan() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(scan);
    }
  }
  new MutationObserver(queueScan).observe(document.documentElement, {
    childList:true, characterData:true, subtree:true, attributes:true, attributeFilter:["href"]
  });
  readWrittenReply();
  scan();
})();
