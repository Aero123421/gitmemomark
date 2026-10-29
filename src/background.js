// Service worker: 保存・自動仕分け・右クリックメニュー・ショートカットの中心。

import {
  getSettings,
  isGitHubReady,
  isJevReady,
  normalizeFolder,
  parseDomainRules,
  parseFolderHints,
  matchDomainRule,
  publicSettings,
  sanitizeItem,
  clampMaxChars,
  truncateMarkdown,
} from "./lib/settings.js";
import { GitHubClient } from "./lib/github.js";
import { classifyFolder } from "./lib/jev.js";
import { buildMarkdown, buildPath, updateIndex } from "./lib/markdown.js";
import { extractPageInfo, VENDOR_FILES } from "./lib/extract.js";

const POPUP = "src/popup/popup.html";
const FOLDER_CACHE_MS = 2 * 60 * 1000;
const X_MATCHES = ["https://x.com/*", "https://twitter.com/*"];
const protectStorage = () => chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
// Establish the boundary before any asynchronous settings reads (also reapplied on install).
protectStorage().catch(console.error);
let saveQueue = Promise.resolve();
function enqueueSave(fn) {
  const result = saveQueue.then(fn);
  saveQueue = result.catch(() => {});
  return result;
}
const clearBadge = () => chrome.action.setBadgeText({ text: "" });

// ---------------------------------------------------------------------------
// フォルダ一覧

function ghClient(s) {
  return new GitHubClient(s.github);
}

async function getRepoFolders(s, { fresh = false } = {}) {
  const key = `${s.github.owner}/${s.github.repo}@${s.github.branch}:${s.github.basePath}`;
  const { folderCache } = await chrome.storage.session.get("folderCache");
  if (!fresh && folderCache && folderCache.key === key && Date.now() - folderCache.at < FOLDER_CACHE_MS) {
    return folderCache.folders;
  }
  const gh = ghClient(s);
  const folders = await gh.listFolders(normalizeFolder(s.github.basePath));
  await chrome.storage.session.set({ folderCache: { key, at: Date.now(), folders, warning: gh.folderWarning || "" } });
  return folders;
}

async function rememberFolder(s, folder) {
  const { folderCache } = await chrome.storage.session.get("folderCache");
  if (!folderCache) return;
  const parts = folder.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    if (!folderCache.folders.includes(p)) folderCache.folders.push(p);
  }
  folderCache.folders.sort();
  await chrome.storage.session.set({ folderCache });
}

/** 候補フォルダ: リポジトリにある実フォルダ ＋ 設定で定義したフォルダ。未仕分けは除く */
async function getFolderCandidates(s, opts) {
  const unsorted = normalizeFolder(s.unsortedFolder) || "_unsorted";
  const hints = parseFolderHints(s.folderHints);
  const desc = new Map(hints.map((h) => [h.name, h.description]));
  let repo = [];
  let error = null;
  try {
    repo = await getRepoFolders(s, opts);
    const { folderCache } = await chrome.storage.session.get("folderCache");
    error = folderCache?.warning || null;
  } catch (e) {
    error = e.message;
  }
  const names = new Set([...hints.map((h) => h.name), ...repo]);
  names.delete(unsorted);
  // 未仕分けフォルダの中のサブフォルダも候補から外す
  const list = [...names]
    .filter((n) => !n.startsWith(unsorted + "/"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, description: desc.get(name) || "" }));
  return { folders: list, unsorted, error };
}

// ---------------------------------------------------------------------------
// 自動仕分け

/**
 * @returns {{folder, via: 'rule'|'jev'|'jev-unsure'|'unsorted', confidence?, suggestion?, warning?}}
 */
async function autoClassify(s, item, { useJev = true } = {}) {
  item = sanitizeItem(item, s);
  const { folders, unsorted, error } = await getFolderCandidates(s);

  const ruleFolder = matchDomainRule(item.url, parseDomainRules(s.domainRules));
  if (ruleFolder) return { folder: ruleFolder, via: "rule" };

  if (useJev && isJevReady(s)) {
    try {
      const r = await classifyFolder(s.jev, item, folders);
      if (r.folder) return { folder: r.folder, via: "jev", confidence: r.confidence, warning: error };
      if (r.excluded) return { folder: unsorted, via: "unsorted", warning: r.reason };
      return { folder: unsorted, via: "jev-unsure", suggestion: r.suggestion, confidence: r.confidence, warning: error };
    } catch (e) {
      return { folder: unsorted, via: "unsorted", warning: e.message };
    }
  }
  return { folder: unsorted, via: "unsorted", warning: error };
}

function classifiedByLabel(c) {
  switch (c.via) {
    case "rule":
      return "domain-rule";
    case "jev":
      return `jev (${Math.round((c.confidence || 0) * 100)}%)`;
    case "jev-unsure":
      return `unsorted (jev unsure: ${c.suggestion ?? "-"} ${Math.round((c.confidence || 0) * 100)}%)`;
    case "manual":
      return "manual";
    default:
      return "unsorted";
  }
}

// ---------------------------------------------------------------------------
// 保存

async function saveItemNow({ item, folder, tags = [], memo = "", classifiedBy = "manual" }) {
  const s = await getSettings();
  item = sanitizeItem(item, s);
  memo = typeof memo === "string" ? memo.slice(0, 20000) : "";
  tags = Array.isArray(tags) ? tags.filter((t) => typeof t === "string").slice(0, 50).map((t) => t.slice(0, 100)) : [];
  classifiedBy = typeof classifiedBy === "string" ? classifiedBy.slice(0, 300) : "manual";
  if (!isGitHubReady(s)) throw new Error("GitHub の設定がまだです。拡張機能の設定画面から登録してください。");

  const basePath = normalizeFolder(s.github.basePath);
  folder = normalizeFolder(folder) || normalizeFolder(s.unsortedFolder) || "_unsorted";
  const now = new Date();
  const path = await buildPath(item, folder, basePath, now);
  const content = buildMarkdown(item, { folder, tags, memo, classifiedBy, savedAt: now });

  const files = [{ path, content, expectedUrl: item.url }];
  if (s.updateIndex) {
    files.push({
      path: [basePath, "INDEX.md"].filter(Boolean).join("/"),
      update: (old) => updateIndex(old, { path, basePath, item, folder, savedAt: now }),
    });
  }

  const gh = ghClient(s);
  const title = (item.title || item.url || "").replace(/\s+/g, " ").slice(0, 60);
  await gh.commitFiles(`📌 ${folder}: ${title}`, files);
  await rememberFolder(s, folder);
  const result = { path, folder, url: gh.fileUrl(path) };
  if (item.source === "x") {
    const { savedTweets = {} } = await chrome.storage.session.get("savedTweets");
    const at = Date.now();
    const recent = Object.fromEntries(Object.entries(savedTweets).filter(([, v]) => at - v.at < 600000));
    const key = `${s.github.owner}/${s.github.repo}@${s.github.branch}:${s.github.basePath}:${item.tweetId}`;
    recent[key] = { at, path, url: result.url };
    await chrome.storage.session.set({ savedTweets: recent });
  }
  return result;
}

function saveItem(args) {
  return enqueueSave(() => saveItemNow(args));
}

function quickSave(item, { dedupe = false } = {}) {
  return enqueueSave(async () => {
    const s = await getSettings();
    item = sanitizeItem(item, s);
    const now = Date.now();
    const { savedTweets = {} } = await chrome.storage.session.get("savedTweets");
    const key = `${s.github.owner}/${s.github.repo}@${s.github.branch}:${s.github.basePath}:${item.tweetId}`;
    const previous = savedTweets[key];
    if (dedupe && item.source === "x" && previous && now - previous.at < 600000) {
      return { skipped: true, path: previous.path, url: previous.url, message: "すでに保存済みです" };
    }
    const c = await autoClassify(s, item, { useJev: s.quickTarget === "auto" });
    const res = await saveItemNow({ item, folder: c.folder, classifiedBy: classifiedByLabel(c) });
    return { ...res, via: c.via, confidence: c.confidence, warning: c.warning };
  });
}

// ---------------------------------------------------------------------------
// ページ情報の取得

function isXStatusUrl(url) {
  return /^https:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+/.test(url || "");
}

async function getItemFromTab(tab) {
  if (!tab?.id) throw new Error("保存するタブが見つかりません。");
  let extractError = "";
  if (isXStatusUrl(tab.url)) {
    try {
      const tweet = await chrome.tabs.sendMessage(tab.id, { type: "gmm:getMainTweet" });
      if (tweet) return tweet;
    } catch (e) {
      extractError = `X ポスト情報を取得できませんでした: ${e.message}`;
    }
  }
  const s = await getSettings();
  const withContent = Boolean(s.web.saveContent);
  try {
    if (withContent) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: VENDOR_FILES });
    }
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageInfo,
      args: [{ withContent, maxChars: clampMaxChars(s.web.maxChars) }],
    });
    if (res?.result) return sanitizeItem({ ...res.result, ...(extractError ? { extractError } : {}) }, s);
    extractError = extractError || "ページの情報を取得できませんでした。";
  } catch (e) {
    extractError = `このページ（chrome:// / PDF ビューア / ウェブストア等）では本文を取り出せません。URL とタイトルのみで続行します: ${e.message}`;
  }
  return { source: "web", url: tab.url, title: tab.title || tab.url, contentError: extractError, extractError };
}

// ---------------------------------------------------------------------------
// 通知（バッジ＋ページ内トースト）

async function flashBadge(ok) {
  await chrome.action.setBadgeBackgroundColor({ color: ok ? "#1a7f37" : "#cf222e" });
  await chrome.action.setBadgeText({ text: ok ? "✓" : "!" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
}

function pageToast(message, ok) {
  const id = "gitmemomark-toast";
  document.getElementById(id)?.remove();
  const el = document.createElement("div");
  el.id = id;
  el.textContent = message;
  el.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "right:20px",
    "bottom:20px",
    "max-width:360px",
    "padding:10px 14px",
    "border-radius:10px",
    "font:13px/1.5 system-ui,sans-serif",
    "color:#fff",
    `background:${ok ? "#1a7f37" : "#cf222e"}`,
    "box-shadow:0 4px 16px rgba(0,0,0,.25)",
    "white-space:pre-line",
  ].join(";");
  document.documentElement.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function notify(tabId, message, ok) {
  await flashBadge(ok);
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: pageToast, args: [message, ok] });
  } catch {
    /* 注入できないページはバッジのみ */
  }
}

function describeQuickResult(r) {
  const how =
    r.via === "jev"
      ? `（Jev が自動仕分け ${Math.round((r.confidence || 0) * 100)}%）`
      : r.via === "rule"
        ? "（ドメインルール）"
        : r.via === "jev-unsure"
          ? "（Jev の確信度が低いため未仕分けへ）"
          : "";
  return `📌 ${r.folder}/ に保存しました${how}${r.warning ? `\n⚠ ${r.warning}` : ""}`;
}

async function quickSaveTab(tab, overrides = {}) {
  if (!tab?.id) return;
  await clearBadge();
  try {
    const item = { ...(await getItemFromTab(tab)), ...overrides };
    const r = await quickSave(item);
    await notify(tab.id, describeQuickResult(r), true);
  } catch (e) {
    await notify(tab.id, `保存に失敗しました: ${e.message}`, false);
  }
}

// ---------------------------------------------------------------------------
// 保存ダイアログ（ポップアップ）を開く

async function openDialog(item, tabId) {
  await clearBadge();
  const s = await getSettings();
  item = sanitizeItem(item, s);
  // storage.session の上限（約 10MB）より十分小さく抑える。maxChars（最大 30 万文字）の範囲では通常発動しない。
  const PENDING_LIMIT = 2_500_000;
  if (JSON.stringify(item).length > PENDING_LIMIT) {
    const otherSize = JSON.stringify({ ...item, content: "" }).length;
    item.content = truncateMarkdown(item.content, Math.max(0, PENDING_LIMIT - otherSize));
    item.contentTruncated = true;
  }
  await chrome.storage.session.set({ pending: { item, tabId, at: Date.now(), fromOpenPopup: true } });
  try {
    await chrome.action.openPopup();
    return;
  } catch {
    /* 開けない環境ではウィンドウで代用 */
  }
  const { pending } = await chrome.storage.session.get("pending");
  if (pending) await chrome.storage.session.set({ pending: { ...pending, fromOpenPopup: false } });
  await chrome.windows.create({
    url: chrome.runtime.getURL(`${POPUP}?pending=1&window=1`),
    type: "popup",
    width: 440,
    height: 700,
  });
}

// ---------------------------------------------------------------------------
// 保存モードに合わせてツールバーボタンの挙動を切り替える

async function applyActionMode() {
  const s = await getSettings();
  await chrome.action.setPopup({ popup: s.saveMode === "quick" ? "" : POPUP });
  await chrome.action.setTitle({
    title: s.saveMode === "quick" ? "GitHub にすぐ保存（ダイアログなし）" : "GitHub に保存",
  });
}

chrome.action.onClicked.addListener((tab) => {
  // popup が空（quick モード）のときだけ呼ばれる
  quickSaveTab(tab);
});

// ---------------------------------------------------------------------------
// 右クリックメニュー

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "gmm-save",
      title: "GitHub に保存（フォルダを選ぶ）",
      contexts: ["page", "selection", "link", "image"],
    });
    chrome.contextMenus.create({
      id: "gmm-quick",
      title: "GitHub にすぐ保存（ダイアログなし）",
      contexts: ["page", "selection", "link", "image"],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await clearBadge();
  if (!tab?.id) return;
  try {
    let item;
    if (info.linkUrl && !info.selectionText) {
      item = { source: "web", url: info.linkUrl, title: info.linkUrl };
      if (isXStatusUrl(info.linkUrl)) item.siteName = "X";
    } else {
      item = await getItemFromTab(tab);
      if (info.selectionText && !item.selection) item.selection = info.selectionText;
      if (info.srcUrl && info.mediaType === "image") item.images = [info.srcUrl];
    }
    if (info.menuItemId === "gmm-quick") {
      const r = await quickSave(item);
      await notify(tab.id, describeQuickResult(r), true);
    } else {
      await openDialog(item, tab.id);
    }
  } catch (e) {
    await notify(tab.id, `保存に失敗しました: ${e.message}`, false);
  }
});

// ---------------------------------------------------------------------------
// ショートカット

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "quick-save") return;
  tab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab) quickSaveTab(tab);
});

// ---------------------------------------------------------------------------
// メッセージ（popup / options / content script から）

const handlers = {
  async "gmm:getFolders"({ fresh }) {
    const s = await getSettings();
    return getFolderCandidates(s, { fresh });
  },
  async "gmm:classify"({ item }) {
    const s = await getSettings();
    return autoClassify(s, item);
  },
  async "gmm:save"(msg) {
    await clearBadge();
    return saveItem(msg);
  },
  async "gmm:quickSave"({ item }, sender) {
    await clearBadge();
    const r = await quickSave(item, { dedupe: Boolean(sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(""))) });
    return { ...r, message: r.skipped ? "すでに保存済みです" : describeQuickResult(r) };
  },
  async "gmm:getPublicSettings"() {
    return publicSettings(await getSettings());
  },
  async "gmm:openDialog"({ item }, sender) {
    await openDialog(item, sender.tab?.id);
    return { ok: true };
  },
  async "gmm:getTabItem"({ tabId }) {
    const tab = await chrome.tabs.get(tabId);
    return getItemFromTab(tab);
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const contentSender = sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(""));
  if (sender.id !== chrome.runtime.id || (contentSender &&
      !["gmm:quickSave", "gmm:openDialog", "gmm:getPublicSettings"].includes(msg?.type))) {
    sendResponse({ ok: false, error: "この送信元からの操作は許可されていません。" });
    return false;
  }
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve().then(() => h(msg, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});

// ---------------------------------------------------------------------------

async function injectExistingXTabs() {
  const tabs = await chrome.tabs.query({ url: X_MATCHES });
  await Promise.all(tabs.map(async (tab) => {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["src/content/x.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content/x.js"] });
    } catch { /* Closed tabs / unavailable pages are harmless. */ }
  }));
}
async function broadcastPublicSettings() {
  const settings = publicSettings(await getSettings());
  const tabs = await chrome.tabs.query({ url: X_MATCHES });
  await Promise.all(tabs.map((tab) => chrome.tabs.sendMessage(tab.id,
    { type: "gmm:publicSettings", settings }).catch(() => {})));
}

chrome.runtime.onInstalled.addListener((details) => {
  protectStorage().catch(console.error);
  setupContextMenus();
  applyActionMode().catch(console.error);
  injectExistingXTabs().catch(console.error);
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => applyActionMode().catch(console.error));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    applyActionMode().catch(console.error);
    chrome.storage.session.remove("folderCache");
    broadcastPublicSettings().catch(console.error);
  }
});
// Re-enabling an extension does not necessarily fire onInstalled or onStartup.
applyActionMode().catch(console.error);
clearBadge().catch(console.error);
