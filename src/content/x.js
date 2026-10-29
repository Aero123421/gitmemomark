// X の旧 UI / 新 UI の両方に対応。保存・秘密設定の取り扱いは background に委譲する。
(() => {
  window.__gitmemomarkX?.dispose?.();
  document.querySelectorAll(".gmm-btn-wrap, .gmm-toast").forEach((el) => el.remove());
  document.querySelectorAll("article[data-gmm]").forEach((el) => el.removeAttribute("data-gmm"));

  let settings = { saveMode: "ask", x: { showButton: true, syncBookmark: false } };
  let disposed = false;
  let ready = false;
  let scanTimer = 0;
  let startupTimer = 0;
  let idleId = 0;
  let lastScan = 0;
  let loggedOutNotified = false;
  const pendingArticles = new Set();
  const savedIds = new Set();
  const savingIds = new Set();
  const recentDialogs = new Map();
  const wraps = new Set();
  const UPDATE_MESSAGE = "拡張機能が更新されました。ページを再読み込みしてください";
  const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" width="18.75" height="18.75"><path fill="currentColor" d="M6 2.5h12A1.5 1.5 0 0 1 19.5 4v17.2a.8.8 0 0 1-1.27.65L12 17.4l-6.23 4.45a.8.8 0 0 1-1.27-.65V4A1.5 1.5 0 0 1 6 2.5Zm.5 2v15.3l5.5-3.93 5.5 3.93V4.5h-11ZM11 7h2v2.5h2.5v2H13V14h-2v-2.5H8.5v-2H11V7Z"/></svg>`;
  const ICON_DONE = `<svg viewBox="0 0 24 24" aria-hidden="true" width="18.75" height="18.75"><path fill="currentColor" d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z"/></svg>`;
  const SEL = {
    text: '[data-testid="tweetText"], div[dir="auto"][class*="whitespace-pre-wrap"]',
    reply: '[data-testid="reply"], [data-engagement-action="reply"]',
    bookmark: '[data-testid="bookmark"], [data-testid="removeBookmark"], [data-engagement-action="bookmark"]',
  };
  const STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/;

  function contextValid() {
    try { return Boolean(chrome.runtime?.id); } catch { return false; }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    clearTimeout(scanTimer);
    clearTimeout(startupTimer);
    if (idleId && window.cancelIdleCallback) cancelIdleCallback(idleId);
    window.removeEventListener("load", afterLoad);
    document.removeEventListener("click", onBookmarkClick, true);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* 更新済み */ }
    wraps.forEach((wrap) => wrap.remove());
    wraps.clear();
    pendingArticles.clear();
  }
  window.__gitmemomarkX = { dispose };

  function ensureContext(userAction = false) {
    if (!disposed && contextValid()) return true;
    dispose();
    if (userAction) toast(UPDATE_MESSAGE, "info");
    return false;
  }

  function topArticle(el) {
    let article = el?.closest?.("article");
    while (article?.parentElement?.closest("article")) article = article.parentElement.closest("article");
    return article;
  }
  function validArticle(article) {
    return article?.ownerDocument === document && article.isConnected && !article.parentElement?.closest("article");
  }
  function topArticles(root = document) {
    return [...root.querySelectorAll("article")].filter(validArticle);
  }
  function inQuote(el, article) {
    if (el.closest("article") !== article) return true;
    const q = el.closest('div[role="link"]');
    return Boolean(q && article.contains(q) && q !== article);
  }
  function statusInfo(article) {
    for (const a of article.querySelectorAll('a[href*="/status/"]')) {
      if (inQuote(a, article) || a.closest(SEL.text)) continue;
      let url;
      try { url = new URL(a.getAttribute("href"), location.origin); } catch { continue; }
      if (!/^(www\.)?(x|twitter)\.com$/.test(url.hostname)) continue;
      const m = url.pathname.match(STATUS_PATH);
      if (m) return { handle: m[1], tweetId: m[2], link: a };
    }
    return null;
  }

  function fullUrl(value) {
    const text = (value || "").trim().replace(/[\u200b\u200e\u200f]/g, "");
    if (!text || /[\s…]|\.{3}/.test(text)) return "";
    if (/^https?:\/\//i.test(text)) {
      try { return new URL(text).hostname ? text : ""; } catch { return ""; }
    }
    return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|$)/i.test(text) ? `https://${text}` : "";
  }
  function linkText(a) {
    const href = a.getAttribute("href") || "";
    // Mention / hashtag / profile links are text, not expanded URLs.
    if (!/^https?:\/\//i.test(href)) return serialize(a, false);
    const expanded = fullUrl(a.getAttribute("data-expanded-url")) || fullUrl(a.getAttribute("title"));
    if (expanded) return expanded;
    const allText = serialize(a, false).trim(); // includes visually-hidden URL spans
    let url;
    try { url = new URL(href); } catch { return allText; }
    if (url.hostname === "t.co") return fullUrl(allText) || href;
    return href;
  }
  function serialize(root, expandLinks = true) {
    if (!root) return "";
    const blocks = /^(DIV|P|LI|BLOCKQUOTE|SECTION|UL|OL|H[1-6])$/;
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      if (/^(SCRIPT|STYLE|SVG)$/.test(node.tagName)) return "";
      if (node.matches('a, button, [role="button"]') && isShowMore(node)) return "";
      if (node.tagName === "IMG") return node.getAttribute("alt") || "";
      if (node.tagName === "BR") return "\n";
      if (expandLinks && node.tagName === "A") return linkText(node);
      const text = [...node.childNodes].map(walk).join("");
      return blocks.test(node.tagName) ? `\n${text}\n` : text;
    }
    return [...root.childNodes].map(walk).join("").replace(/\n{3,}/g, "\n\n").trim();
  }
  function idToIso(id) {
    try {
      // Last known sequential ID (TweetedAt's pre-Snowflake dataset).
      // These IDs must not acquire a fictitious November 2010 date.
      if (BigInt(id) <= 29700859247n) return "";
      const ms = Number((BigInt(id) >> 22n) + 1288834974657n);
      return ms > 1288834974657 ? new Date(ms).toISOString() : "";
    } catch { return ""; }
  }
  function publishedDate(article, info) {
    const time = [...article.querySelectorAll("time[datetime]")].find((el) => !inQuote(el, article));
    if (time?.getAttribute("datetime")) return time.getAttribute("datetime");
    const snowflake = idToIso(info.tweetId);
    if (snowflake) return snowflake;
    for (const value of [info.link.getAttribute("aria-label"), info.link.title, serialize(info.link, false)]) {
      if (!value) continue;
      // Only parse an absolute date with a year; relative labels such as "3h" are ambiguous.
      if (!/(?:19|20)\d{2}/.test(value)) continue;
      const jp = value.match(/((?:19|20)\d{2})年(\d{1,2})月(\d{1,2})日/);
      if (jp) {
        const date = `${jp[1]}-${jp[2].padStart(2, "0")}-${jp[3].padStart(2, "0")}`;
        const clock = value.match(/(午前|午後)?\s*(\d{1,2}):(\d{2})/);
        if (!clock) return date;
        let hour = Number(clock[2]);
        if (clock[1]) hour = hour % 12 + (clock[1] === "午後" ? 12 : 0);
        // Keep the displayed local wall time; the label does not identify a zone.
        return `${date}T${String(hour).padStart(2, "0")}:${clock[3]}:00`;
      }
      const ms = Date.parse(value.replace(/\s*·\s*/g, " "));
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
    return "";
  }
  function isCardImage(img) {
    return Boolean(img.closest('[data-testid="card.wrapper"], [data-testid="card.layoutLarge.media"], [data-slot*="card"], a[href*="/i/article/"], [class*="group/article-card"]')) ||
      /(?:記事のカバー|article cover)/i.test(img.alt || "");
  }
  function originalImage(src) {
    try { const url = new URL(src); url.searchParams.set("name", "orig"); return url.href; } catch { return src; }
  }
  function isShowMore(el) {
    const label = (el.textContent || el.getAttribute("aria-label") || "").trim();
    return el.getAttribute("data-testid") === "tweet-text-show-more-link" || /^(Show more|さらに表示|もっと見る)$/i.test(label);
  }
  function extractTweet(article) {
    const info = statusInfo(article);
    if (!info) return null;
    const { handle, tweetId } = info;
    const texts = [...article.querySelectorAll(SEL.text)];
    const mainText = texts.find((el) => !inQuote(el, article));
    const quoteText = texts.find((el) => inQuote(el, article));
    const text = serialize(mainText);
    let author = "";
    for (const a of article.querySelectorAll(`a[href="/${handle}" i]`)) {
      if (inQuote(a, article) || a.querySelector('img[src*="profile_images/"], img[src*="profile_banners/"]')) continue;
      const name = serialize(a, false).split("\n")[0].trim();
      if (name && !name.startsWith("@")) { author = name; break; }
    }
    if (!author) {
      const u = [...article.querySelectorAll('[data-testid="User-Name"]')].find((el) => !inQuote(el, article));
      author = serialize(u, false).split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("@") && line !== "·") || "";
      author = author.replace(/\s*@\w+.*$/, "");
    }
    const images = [];
    const videos = [];
    for (const el of article.querySelectorAll("img[src], video[poster]")) {
      if (inQuote(el, article) || isCardImage(el)) continue;
      const src = el.getAttribute(el.tagName === "VIDEO" ? "poster" : "src") || "";
      if (/pbs\.twimg\.com\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(src)) videos.push(src);
      else if (/pbs\.twimg\.com\/media\//.test(src)) images.push(originalImage(src));
    }
    const ownStatus = location.pathname.match(STATUS_PATH)?.[2] === tweetId;
    const showMore = [...article.querySelectorAll('a, button, [role="button"]')].some((el) => {
      if (inQuote(el, article) || !isShowMore(el)) return false;
      // Header/menu buttons can also be labelled "Show more". Only the text's
      // expander (inside the text or immediately after it) indicates truncation.
      return el.getAttribute("data-testid") === "tweet-text-show-more-link" ||
        Boolean(mainText && (mainText.contains(el) || mainText.nextElementSibling === el || mainText.nextElementSibling?.contains(el)));
    });
    const short = text.replace(/\s+/g, " ").slice(0, 60);
    return {
      source: "x", siteName: "X", url: `https://x.com/${handle}/status/${tweetId}`,
      tweetId, authorHandle: handle, author, text, quoted: serialize(quoteText),
      images: [...new Set(images)], videos: [...new Set(videos)], textTruncated: Boolean(showMore && !ownStatus),
      publishedAt: publishedDate(article, info),
      title: `${author || "@" + handle}: ${short || "(ポスト)"}${text.length > 60 ? "…" : ""}`,
    };
  }
  function findMainTweet() {
    const id = location.pathname.match(STATUS_PATH)?.[2];
    if (!id) return null;
    for (const article of topArticles()) {
      const item = extractTweet(article);
      if (item?.tweetId === id) return item;
    }
    return null;
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      if (!ensureContext()) return reject(new Error(UPDATE_MESSAGE));
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          let error;
          try { error = chrome.runtime.lastError?.message; } catch { error = UPDATE_MESSAGE; }
          if (!contextValid()) { dispose(); error = UPDATE_MESSAGE; }
          if (error) {
            if (/context invalidated/i.test(error) || !contextValid()) { dispose(); error = UPDATE_MESSAGE; }
            reject(new Error(error));
          } else if (!res?.ok) reject(new Error(res?.error || "不明なエラー"));
          else resolve(res.result);
        });
      } catch (e) {
        if (/context invalidated/i.test(e.message) || !contextValid()) { dispose(); reject(new Error(UPDATE_MESSAGE)); }
        else reject(e);
      }
    });
  }
  async function saveTweet(article, { forceQuick = false, bookmark = false } = {}) {
    if (!ensureContext(true) || !validArticle(article)) return;
    const item = extractTweet(article);
    if (!item) return toast("ポストの情報を取得できませんでした", "error");
    const id = item.tweetId;
    if (savingIds.has(id)) return;
    if (savedIds.has(id)) {
      if (!bookmark) toast("すでに保存済みです", "info");
      return;
    }
    const openDialog = !forceQuick && settings.saveMode !== "quick";
    if (openDialog && Date.now() - (recentDialogs.get(id) || 0) < 3000) return;
    if (openDialog) recentDialogs.set(id, Date.now());
    savingIds.add(id);
    syncArticle(article);
    try {
      if (openDialog) {
        await send({ type: "gmm:openDialog", item });
      } else {
        const result = await send({ type: "gmm:quickSave", item });
        savedIds.add(id);
        toast(result?.message || "GitHub に保存しました", result?.skipped ? "info" : "ok");
      }
    } catch (e) {
      if (openDialog) recentDialogs.delete(id);
      toast(e.message === UPDATE_MESSAGE ? UPDATE_MESSAGE : `保存に失敗しました: ${e.message}`, "error");
    } finally {
      savingIds.delete(id);
      if (!disposed) topArticles().forEach(syncArticle);
    }
  }

  function findActionBar(article) {
    const reply = [...article.querySelectorAll(SEL.reply)].find((el) => !inQuote(el, article));
    if (!reply) return null;
    const layout = reply.matches("[data-engagement-action]") ? "new" : "old";
    const bar = layout === "new" ? reply.parentElement : reply.closest('[role="group"]') || reply.parentElement?.parentElement;
    return bar && article.contains(bar) ? { bar, layout } : null;
  }
  function updateButton(btn, id) {
    const done = savedIds.has(id);
    const busy = savingIds.has(id);
    if (btn.dataset.tweetId !== id || btn.classList.contains("gmm-done") !== done) btn.innerHTML = done ? ICON_DONE : ICON;
    btn.dataset.tweetId = id;
    btn.classList.toggle("gmm-done", done);
    btn.classList.toggle("gmm-busy", busy);
    btn.setAttribute("aria-busy", String(busy));
    btn.setAttribute("aria-label", done ? "GitHub に保存済み" : "GitHub に保存");
    btn.title = done ? "GitHub に保存済み" : "GitHub に保存（GitMemoMark）\nShift+クリックでダイアログなしで保存";
  }
  function syncArticle(article) {
    if (!validArticle(article)) return;
    const info = statusInfo(article);
    const found = findActionBar(article);
    // Article nodes may be recycled, or just their action bars replaced by React.
    for (const wrap of article.querySelectorAll(".gmm-btn-wrap")) {
      if (!inQuote(wrap, article) && (!settings.x.showButton || !info || !found?.bar.contains(wrap))) { wraps.delete(wrap); wrap.remove(); }
    }
    if (!settings.x.showButton || !info || !found) return;
    const { bar, layout } = found;
    let btn = bar.querySelector(".gmm-btn-wrap .gmm-btn");
    if (!btn) {
      const wrap = document.createElement("div");
      wrap.className = `gmm-btn-wrap gmm-${layout}`;
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gmm-btn";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.isTrusted || !ensureContext(true)) return;
        const current = topArticle(btn);
        if (validArticle(current) && current.contains(btn)) saveTweet(current, { forceQuick: e.shiftKey });
      });
      // Preserve native Enter/Space activation while preventing X's article shortcuts.
      for (const type of ["keydown", "keyup"]) btn.addEventListener(type, (e) => e.stopPropagation());
      wrap.appendChild(btn);
      wraps.add(wrap);
      const share = layout === "new" ? bar.querySelector('[data-engagement-action="share"]') : null;
      if (share && !inQuote(share, article)) share.parentElement.insertBefore(wrap, share);
      else bar.appendChild(wrap);
    }
    updateButton(btn, info.tweetId);
  }

  function queueArticle(el) {
    const article = topArticle(el);
    if (article) pendingArticles.add(article);
  }
  function scheduleScan(all = false) {
    if (disposed) return;
    if (all) topArticles().forEach((article) => pendingArticles.add(article));
    if (!ready || scanTimer || !pendingArticles.size) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      if (!ensureContext()) return;
      lastScan = performance.now();
      const articles = [...pendingArticles];
      pendingArticles.clear();
      for (const wrap of wraps) if (!wrap.isConnected) wraps.delete(wrap);
      articles.forEach(syncArticle);
    }, Math.max(0, 250 - (performance.now() - lastScan)));
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      if (target?.closest(".gmm-btn-wrap, .gmm-toast")) continue;
      if (record.type === "childList" && [...record.addedNodes, ...record.removedNodes].every((node) => node.nodeType === Node.ELEMENT_NODE && node.matches(".gmm-btn-wrap, .gmm-toast"))) continue;
      queueArticle(target);
      for (const node of record.addedNodes || []) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        queueArticle(node);
        if (!topArticle(node)) node.querySelectorAll("article").forEach(queueArticle);
      }
    }
    scheduleScan();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href", "data-testid", "data-engagement-action"] });

  function afterLoad() {
    // Do not mutate SSR articles during hydration. Later mutations are batched at 250 ms.
    startupTimer = setTimeout(() => {
      const start = () => { if (disposed) return; ready = true; scheduleScan(true); };
      if (window.requestIdleCallback) idleId = requestIdleCallback(start, { timeout: 1500 });
      else start();
    }, 1500);
  }
  if (document.readyState === "complete") afterLoad();
  else window.addEventListener("load", afterLoad, { once: true });

  function loggedIn() {
    // Prefer authenticated navigation over stale login links. New UI need not expose
    // the old account-switcher testid; only a concrete logged-out prompt blocks sync.
    if (document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"], [data-testid="AccountSwitcher"], nav a[href="/notifications"], nav a[href="/messages"], a[href="/compose/post"], a[href="/compose/tweet"]')) return true;
    const prompts = [...document.querySelectorAll('a[href*="/i/flow/login"], a[href="/login"], a[href*="/i/flow/signup"], a[href*="/i/jf/onboarding/"], [data-testid="loginButton"], [data-testid="signupButton"]')];
    const loggedOut = prompts.some((el) => !el.closest("article") && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
    if (loggedOut && !loggedOutNotified) {
      loggedOutNotified = true;
      toast("ログインしていないためブックマーク連動は無効です", "info");
    }
    return !loggedOut;
  }
  function onBookmarkClick(e) {
    if (!e.isTrusted || !settings.x.syncBookmark) return;
    const bm = e.target.closest?.(SEL.bookmark);
    if (!bm || !ensureContext(true) || !loggedIn()) return;
    if (bm.matches('[data-testid="removeBookmark"]') || bm.querySelector('[data-testid="removeBookmark"]')) return;
    const pressed = bm.closest("button[aria-pressed]") || (bm.matches("[aria-pressed]") ? bm : bm.querySelector("[aria-pressed]"));
    if (pressed?.getAttribute("aria-pressed") === "true") return;
    const article = topArticle(bm);
    if (validArticle(article) && !inQuote(bm, article)) saveTweet(article, { forceQuick: true, bookmark: true });
  }
  document.addEventListener("click", onBookmarkClick, true);

  function toast(message, kind = "ok") {
    document.querySelectorAll(".gmm-toast").forEach((el) => el.remove());
    const el = document.createElement("div");
    el.className = `gmm-toast gmm-${kind === "error" ? "ng" : kind}`;
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.textContent = message;
    (document.body || document.documentElement).appendChild(el);
    setTimeout(() => el.classList.add("gmm-hide"), 3500);
    setTimeout(() => el.remove(), 4000);
  }
  function applySettings(s) {
    settings = {
      saveMode: s?.saveMode === "quick" ? "quick" : "ask",
      x: { showButton: s?.x?.showButton !== false, syncBookmark: s?.x?.syncBookmark === true },
    };
    scheduleScan(true);
  }
  function onMessage(msg, _sender, sendResponse) {
    if (!ensureContext()) return;
    if (msg?.type === "gmm:getMainTweet") sendResponse(findMainTweet());
    else if (msg?.type === "gmm:publicSettings") applySettings(msg.settings);
  }
  chrome.runtime.onMessage.addListener(onMessage);
  send({ type: "gmm:getPublicSettings" }).then(applySettings).catch(() => { /* 未対応の background では安全な既定値 */ });
})();
