import { setTheme } from "../lib/theme.js";
import { getSettings, saveSettings, normalizeFolder, parseFolderHints } from "../lib/settings.js";
import { GitHubClient } from "../lib/github.js";
import { pingJev } from "../lib/jev.js";

const $ = (id) => document.getElementById(id);
const radios = (name) => [...document.querySelectorAll(`input[name="${name}"]`)];

function setResult(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.className = `result ${ok === undefined ? "" : ok ? "ok" : "ng"}`;
}

function fill(s) {
  $("theme").value = s.theme || "system";
  $("gh-owner").value = s.github.owner;
  $("gh-repo").value = s.github.repo;
  $("gh-branch").value = s.github.branch;
  $("gh-base").value = s.github.basePath;
  $("gh-token").value = s.github.token;
  radios("saveMode").forEach((r) => (r.checked = r.value === s.saveMode));
  radios("quickTarget").forEach((r) => (r.checked = r.value === s.quickTarget));
  $("unsorted").value = s.unsortedFolder;
  $("folder-hints").value = s.folderHints;
  $("domain-rules").value = s.domainRules;
  $("jev-enabled").checked = s.jev.enabled;
  $("jev-key").value = s.jev.apiKey;
  $("jev-model").value = s.jev.model;
  $("jev-threshold").value = s.jev.threshold;
  $("jev-send-content").checked = s.jev.sendContent;
  $("jev-exclude-domains").value = s.jev.excludeDomains;
  $("x-button").checked = s.x.showButton;
  $("x-sync").checked = s.x.syncBookmark;
  $("update-index").checked = s.updateIndex;
  $("web-content").checked = s.web.saveContent;
  $("web-max").value = s.web.maxChars;
  updateDerived();
}

function collect() {
  // "https://github.com/owner/repo" を貼られた場合にも対応
  let owner = $("gh-owner").value.trim();
  let repo = $("gh-repo").value.trim().replace(/\.git$/, "");
  const m = (owner + " " + repo).match(/github\.com\/([^/\s]+)\/([^/\s]+)/);
  if (m) {
    owner = m[1];
    repo = m[2].replace(/\.git$/, "");
  }
  return {
    theme: $("theme").value,
    github: {
      owner,
      repo,
      branch: $("gh-branch").value.trim() || "main",
      basePath: normalizeFolder($("gh-base").value),
      token: $("gh-token").value.trim(),
    },
    saveMode: radios("saveMode").find((r) => r.checked)?.value || "ask",
    quickTarget: radios("quickTarget").find((r) => r.checked)?.value || "auto",
    unsortedFolder: normalizeFolder($("unsorted").value) || "_unsorted",
    folderHints: $("folder-hints").value,
    domainRules: $("domain-rules").value,
    jev: {
      enabled: $("jev-enabled").checked,
      apiKey: $("jev-key").value.trim(),
      model: $("jev-model").value.trim() || "jev-latest",
      threshold: Number($("jev-threshold").value),
      sendContent: $("jev-send-content").checked,
      excludeDomains: $("jev-exclude-domains").value,
    },
    x: {
      showButton: $("x-button").checked,
      syncBookmark: $("x-sync").checked,
    },
    web: {
      saveContent: $("web-content").checked,
      maxChars: Math.min(300000, Math.max(1000, Number($("web-max").value) || 100000)),
    },
    updateIndex: $("update-index").checked,
  };
}

function updateDerived() {
  $("jev-fields").hidden = !$("jev-enabled").checked;
  $("jev-fields").disabled = !$("jev-enabled").checked;
  $("jev-threshold-out").textContent = `${Math.round(Number($("jev-threshold").value) * 100)}%`;
}

$("jev-enabled").addEventListener("change", updateDerived);
$("theme").addEventListener("change", () => setTheme($("theme").value));
addEventListener("gmm-theme", () => { $("theme").value = document.documentElement.dataset.themePreference; });

$("jev-threshold").addEventListener("input", updateDerived);

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const s = collect();
  await saveSettings(s);
  fill(s);
  setResult("save-result", "保存しました", true);
  setTimeout(() => setResult("save-result", ""), 3000);
});

$("test-gh").addEventListener("click", async () => {
  const s = collect();
  if (!s.github.owner || !s.github.repo || !s.github.token) {
    return setResult("test-gh-result", "オーナー・リポジトリ名・トークンを入力してください", false);
  }
  setResult("test-gh-result", "確認中…");
  try {
    const gh = new GitHubClient(s.github);
    const repo = await gh.getRepo();
    if (repo.permissions && !repo.permissions.push) {
      return setResult("test-gh-result", `${repo.full_name} に書き込み権限がありません`, false);
    }
    const folders = await gh.listFolders(s.github.basePath);
    setResult(
      "test-gh-result",
      `${repo.full_name}（${repo.private ? "非公開" : "公開"}）に接続できました。フォルダ ${folders.length} 個${gh.folderWarning ? ` ${gh.folderWarning}` : ""}`,
      true
    );
  } catch (err) {
    setResult("test-gh-result", `${err.message}`, false);
  }
});

$("load-folders").addEventListener("click", async () => {
  const s = collect();
  setResult("load-folders-result", "読み込み中…");
  try {
    const gh = new GitHubClient(s.github);
    const folders = await gh.listFolders(s.github.basePath);
    const existing = new Set(parseFolderHints($("folder-hints").value).map((f) => f.name));
    const add = folders.filter((f) => !existing.has(f) && f !== s.unsortedFolder && !f.startsWith(s.unsortedFolder + "/"));
    if (add.length) {
      const ta = $("folder-hints");
      ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + add.map((f) => `${f}: `).join("\n");
    }
    setResult("load-folders-result", `${add.length} 個追加しました（説明を書いておくと Jev の精度が上がります）${gh.folderWarning ? ` ${gh.folderWarning}` : ""}`, true);
  } catch (err) {
    setResult("load-folders-result", `${err.message}`, false);
  }
});

$("test-jev").addEventListener("click", async () => {
  const s = collect();
  if (!s.jev.apiKey) return setResult("test-jev-result", "API キーを入力してください", false);
  setResult("test-jev-result", "確認中…");
  try {
    const model = await pingJev(s.jev);
    setResult("test-jev-result", `接続できました（モデル: ${model}）`, true);
  } catch (err) {
    setResult("test-jev-result", `${err.message}`, false);
  }
});

getSettings().then(fill);
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "local" && changes.settings) {
    const old = { ...changes.settings.oldValue }, next = { ...changes.settings.newValue };
    // Theme saves must not reset unsaved edits, including first-run defaults.
    if (old.theme !== next.theme) return;
    delete old.theme; delete next.theme;
    if (JSON.stringify(old) !== JSON.stringify(next)) fill(await getSettings());
  }
});
