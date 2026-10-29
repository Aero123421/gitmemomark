import { bindThemeToggle } from "../lib/theme.js";
import { getSettings, isGitHubReady, isJevReady, normalizeFolder } from "../lib/settings.js";

const $ = (id) => document.getElementById(id);
bindThemeToggle($("theme-toggle"));
const params = new URLSearchParams(location.search);
const isWindow = params.has("window");
if (isWindow) document.body.classList.add("window");

let item = null;
let unsorted = "_unsorted";
let userPickedFolder = false;
let classifiedBy = "manual";
let autoResult = null;
let currentSettings = null;
let classificationRun = 0;
let extractionWarning = "";
let folderWarning = "";
function showSuggestion(text = "") {
  $("suggest").textContent = [extractionWarning, folderWarning, text].filter(Boolean).join("\n");
}

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || "不明なエラー"));
      resolve(res.result);
    });
  });
}

function setStatus(text, kind = "") {
  const el = $("status");
  el.className = `status ${kind}`;
  el.textContent = text;
}

$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("setup-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());

// ---------------------------------------------------------------------------

async function loadItem() {
  await chrome.action.setBadgeText({ text: "" });
  const { pending } = await chrome.storage.session.get("pending");
  if (isWindow) {
    if (!pending || Date.now() - pending.at >= 60000) throw new Error("保存対象がありません。元のページから保存画面を開き直してください。");
    await chrome.storage.session.remove("pending");
    return pending.item;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (pending && Date.now() - pending.at < 60000 &&
      (pending.tabId === tab?.id || (pending.fromOpenPopup && Date.now() - pending.at < 10000))) {
    await chrome.storage.session.remove("pending");
    return pending.item;
  }
  if (!tab || tab.url?.startsWith(chrome.runtime.getURL(""))) throw new Error("保存元のページを選んでから開き直してください。");
  return send({ type: "gmm:getTabItem", tabId: tab.id });
}

function renderItem() {
  $("source-badge").textContent = item.source === "x" ? "X ポスト" : "Web";
  $("url").textContent = item.url;
  $("url").href = item.url;
  $("title").value = item.title || item.url;
  const excerpt = item.selection || item.text || item.description || "";
  if (excerpt) {
    $("excerpt").textContent = excerpt;
    $("excerpt-box").hidden = false;
    $("preview-box").hidden = false;
    const summary = $("excerpt-box").querySelector(".preview-label");
    if (item.selection) summary.textContent = "選択したテキスト";
    else if (item.source !== "x") summary.textContent = "ページの説明文";
    else summary.textContent = "ポストの本文";
  }
  if (item.source !== "x" && item.content) {
    $("content-row").hidden = false;
    $("preview-box").hidden = false;
    $("content-preview").hidden = false;
    $("content-len").textContent = `約 ${item.content.length.toLocaleString()} 文字`;
    $("content-preview").textContent = item.content.slice(0, 3000) + (item.content.length > 3000 ? "\n…" : "");
  }
  if (item.contentError || item.extractError) {
    extractionWarning = `本文抽出: ${item.contentError || item.extractError}`;
    showSuggestion();
  }
}

function renderFolders(folders) {
  const sel = $("folder");
  const current = sel.value;
  sel.innerHTML = "";
  const u = new Option(`${unsorted}（未仕分け）`, unsorted);
  sel.add(u);
  for (const f of folders) {
    const label = f.description ? `${f.name} — ${f.description}` : `${f.name}`;
    sel.add(new Option(label, f.name));
  }
  if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
}

function selectFolder(name) {
  const sel = $("folder");
  if (![...sel.options].some((o) => o.value === name)) sel.add(new Option(`${name}`, name));
  sel.value = name;
}

function pct(x) {
  return `${Math.round((x || 0) * 100)}%`;
}

async function runAutoClassify(settings) {
  const run = ++classificationRun;
  if (isJevReady(settings)) showSuggestion("Jev がフォルダを判定中…");
  try {
    const r = await send({ type: "gmm:classify", item: { ...item, title: $("title").value,
      memo: $("memo").value.trim(), content: $("with-content").checked ? item.content : "" } });
    if (run !== classificationRun) return;
    autoResult = r;
    let message = "";
    if (r.via === "rule") {
      message = `ドメインルールにより「${r.folder}」を選択しました`;
    } else if (r.via === "jev") {
      message = `Jev のおすすめ: ${r.folder}（${pct(r.confidence)}）`;
    } else if (r.via === "jev-unsure") {
      message = `Jev は自信なし（${r.suggestion ?? "-"} ${pct(r.confidence)}）→ 未仕分けを選択`;
    }
    if (r.warning && folderWarning !== `${r.warning}`) message += `${message ? "\n" : ""}${r.warning}`;
    showSuggestion(message);
    if (!userPickedFolder) {
      selectFolder(r.folder);
      classifiedBy = labelFor(r);
    }
  } catch (e) {
    if (run === classificationRun) showSuggestion(`自動判定に失敗: ${e.message}`);
  }
}

$("reclassify").addEventListener("click", () => {
  if (!item || !currentSettings) return;
  userPickedFolder = false;
  runAutoClassify(currentSettings);
});

function labelFor(r) {
  if (r.via === "rule") return "domain-rule";
  if (r.via === "jev") return `jev (${pct(r.confidence)})`;
  if (r.via === "jev-unsure") return `unsorted (jev unsure: ${r.suggestion ?? "-"} ${pct(r.confidence)})`;
  return "manual";
}

// ---------------------------------------------------------------------------

$("folder").addEventListener("change", () => {
  userPickedFolder = true;
  classifiedBy = autoResult && $("folder").value === autoResult.folder ? labelFor(autoResult) : "manual";
});

$("new-folder-btn").addEventListener("click", () => {
  const input = $("new-folder");
  input.hidden = !input.hidden;
  $("new-folder-btn").setAttribute("aria-expanded", String(!input.hidden));
  $("folder").disabled = !input.hidden;
  if (!input.hidden) input.focus();
});

$("form").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $("form").requestSubmit();
  }
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!item) return;
  ++classificationRun;
  const newFolder = $("new-folder").hidden ? "" : normalizeFolder($("new-folder").value);
  const folder = newFolder || $("folder").value || unsorted;
  const tags = $("tags")
    .value.split(/[,、\s]+/)
    .map((t) => t.replace(/^#/, "").trim())
    .filter(Boolean);

  $("save").disabled = true;
  setStatus("保存中…");
  try {
    const r = await send({
      type: "gmm:save",
      item: {
        ...item,
        title: $("title").value.trim() || item.title,
        content: $("with-content").checked ? item.content : "",
      },
      folder,
      tags,
      memo: $("memo").value.trim(),
      classifiedBy: newFolder ? "manual" : classifiedBy,
    });
    const el = $("status");
    el.className = "status ok";
    el.textContent = `${r.folder}/ に保存しました `;
    const a = document.createElement("a");
    a.href = r.url;
    a.target = "_blank";
    a.textContent = "GitHub で見る";
    el.appendChild(a);
    setTimeout(() => window.close(), 1800);
  } catch (err) {
    setStatus(`${err.message}`, "ng");
    $("save").disabled = false;
  }
});

// ---------------------------------------------------------------------------

(async function init() {
  const settings = currentSettings = await getSettings();
  $("repo-label").textContent = settings.github.owner && settings.github.repo ? `${settings.github.owner}/${settings.github.repo}` : "";
  $("repo-label").title = $("repo-label").textContent;
  if (!isGitHubReady(settings)) {
    $("setup").hidden = false;
    return;
  }
  $("form").hidden = false;
  unsorted = normalizeFolder(settings.unsortedFolder) || "_unsorted";
  renderFolders([]);

  const foldersP = send({ type: "gmm:getFolders" })
    .then((r) => {
      unsorted = r.unsorted;
      renderFolders(r.folders);
      folderWarning = r.error ? `${r.error}` : "";
      showSuggestion();
    })
    .catch((e) => { folderWarning = `${e.message}`; showSuggestion(); });

  try {
    item = await loadItem();
  } catch (e) {
    setStatus(`ページ情報を取得できませんでした: ${e.message}`, "ng");
    $("save").disabled = true;
    return;
  }
  renderItem();
  $("memo").focus();
  await foldersP;
  runAutoClassify(settings);
})();

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.settings) return;
  currentSettings = await getSettings();
  unsorted = normalizeFolder(currentSettings.unsortedFolder) || "_unsorted";
  $("repo-label").textContent = `${currentSettings.github.owner}/${currentSettings.github.repo}`;
  $("repo-label").title = $("repo-label").textContent;
  const before = { ...changes.settings.oldValue }, after = { ...changes.settings.newValue };
  delete before.theme; delete after.theme;
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (!item && isGitHubReady(currentSettings) && !$("setup").hidden) { location.reload(); return; }
  if (!isGitHubReady(currentSettings)) { $("setup").hidden = false; $("form").hidden = true; return; }
  try {
    const result = await send({ type: "gmm:getFolders" });
    renderFolders(result.folders);
    folderWarning = result.error || "";
    showSuggestion();
  } catch (error) { folderWarning = error.message; showSuggestion(); }
});
