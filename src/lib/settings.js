// 設定の読み書き。トークン類を含むため chrome.storage.local（同期しない）に保存する。

export const DEFAULT_SETTINGS = {
  theme: "system", // UI only; stored locally, never sent to content scripts.
  github: {
    token: "",
    owner: "",
    repo: "",
    branch: "main",
    basePath: "", // ブックマークを置くルート（空ならリポジトリ直下）
  },
  // "ask": 毎回フォルダを選ぶ画面を出す / "quick": 画面を出さずにすぐ保存
  saveMode: "ask",
  // quick 保存: ドメインルール優先。"auto" は Jev、"unsorted" は Jev を使わず未仕分けへ。
  quickTarget: "auto",
  unsortedFolder: "_unsorted",
  // 1 行 1 フォルダ。「フォルダ名: 説明」。説明は Jev の判断材料になる
  folderHints: "",
  // 1 行 1 ルール。「ドメイン = フォルダ」。Jev より優先される
  domainRules: "",
  jev: {
    enabled: false,
    apiKey: "",
    model: "jev-latest",
    threshold: 0.5, // choice.confidence がこれ未満なら未仕分けへ
    sendContent: false, // 明示的に許可した場合のみ本文の先頭 2000 文字を送る
    excludeDomains: "", // 1 行 1 ドメイン。サブドメインも送信対象から除外
  },
  x: {
    showButton: true, // ポストに保存ボタンを追加
    syncBookmark: false, // X のブックマークボタンを押したら自動保存
  },
  web: {
    saveContent: true, // 普通のサイトの本文を Markdown に変換して保存
    maxChars: 100000, // 本文の最大文字数
  },
  updateIndex: true, // INDEX.md に一覧を追記
};

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const merged = deepMerge(DEFAULT_SETTINGS, settings || {});
  merged.web.maxChars = clampMaxChars(merged.web.maxChars);
  if (!["light", "dark", "system"].includes(merged.theme)) merged.theme = "system";
  return merged;
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

export function isGitHubReady(s) {
  return Boolean(s.github.token && s.github.owner && s.github.repo);
}

export function isJevReady(s) {
  return Boolean(s.jev.enabled && s.jev.apiKey);
}

/** "tech: 技術記事" の行を [{name, description}] にする */
export function parseFolderHints(text) {
  return (text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.search(/[:：]/);
      const name = normalizeFolder(i >= 0 ? l.slice(0, i) : l);
      const description = i >= 0 ? l.slice(i + 1).trim() : "";
      return { name, description };
    })
    .filter((f) => f.name);
}

/** "x.com = x" の行を [{domain, folder}] にする */
export function parseDomainRules(text) {
  return (text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [d, f] = l.split(/=|→|->/).map((x) => (x || "").trim());
      return { domain: (d || "").toLowerCase().replace(/^www\./, ""), folder: normalizeFolder(f) };
    })
    .filter((r) => r.domain && r.folder);
}

export function matchDomainRule(url, rules) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  for (const r of rules) {
    if (host === r.domain || host.endsWith("." + r.domain)) return r.folder;
  }
  return null;
}

/** フォルダパスの正規化（前後のスラッシュ除去・危険な文字の除去） */
export function normalizeFolder(path) {
  return String(path || "")
    .split("/")
    .map((seg) => {
      let clean = seg.replace(/[\x00-\x1f\x7f`\\:*?"<>|#]/g, "").trim()
        .replace(/^\.+/, "").replace(/[. ]+$/g, "");
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = "_" + clean;
      return clean;
    })
    .filter(Boolean)
    .join("/");
}

export function clampMaxChars(value) {
  const n = Number(value);
  return Math.min(300000, Math.max(1000, Number.isFinite(n) && n > 0 ? Math.floor(n) : 100000));
}

export function publicSettings(s) {
  return { saveMode: s.saveMode === "quick" ? "quick" : "ask",
    x: { showButton: Boolean(s.x.showButton), syncBookmark: Boolean(s.x.syncBookmark) } };
}

export function isExcludedDomain(url, text) {
  const rules = String(text || "").split(/\r?\n/).map((domain) => ({
    domain: domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""),
    folder: "excluded",
  })).filter((r) => r.domain && !r.domain.startsWith("#"));
  return Boolean(matchDomainRule(url, rules));
}

/** Untrusted runtime payloads: return only the supported, bounded item fields. */
export function sanitizeItem(input, settings = DEFAULT_SETTINGS) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("保存するデータが不正です。");
  const str = (v, max) => typeof v === "string" ? v.slice(0, max) : "";
  const httpUrl = (v, required = false) => {
    const value = str(v, 8192);
    try {
      const u = new URL(value);
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || value.length !== v.length || u.href.length > 8192) throw new Error();
      return u.href;
    } catch {
      if (required) throw new Error("保存 URL は http(s) の URL を指定してください。");
      return "";
    }
  };
  const source = input.source === "x" ? "x" : "web";
  const out = { source };
  if (source === "x") {
    if (typeof input.tweetId !== "string" || !/^\d{1,25}$/.test(input.tweetId) ||
        typeof input.authorHandle !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(input.authorHandle)) {
      throw new Error("X ポストの ID またはユーザー名が不正です。");
    }
    out.tweetId = input.tweetId;
    out.authorHandle = input.authorHandle.toLowerCase();
    const canonical = `https://x.com/${input.authorHandle}/status/${input.tweetId}`;
    if (input.url !== canonical) throw new Error("X ポストの URL と ID が一致しません。");
    out.url = `https://x.com/${out.authorHandle}/status/${out.tweetId}`;
  } else {
    out.url = httpUrl(input.url, true);
  }
  for (const [key, max] of Object.entries({ title: 300, text: 20000, quoted: 20000, author: 300,
    publishedAt: 100, description: 2000, selection: 20000, siteName: 300, memo: 20000,
    contentError: 1000, extractError: 1000 })) out[key] = str(input[key], max);
  if (!out.title || out.title === input.url) {
    const url = new URL(out.url);
    try { out.title = decodeURIComponent(url.hostname + (url.pathname === "/" ? "" : url.pathname)).slice(0, 300); }
    catch { out.title = (url.hostname + url.pathname).slice(0, 300); }
  }
  const maxChars = clampMaxChars(settings.web?.maxChars);
  const rawContent = typeof input.content === "string" ? input.content : "";
  // 閉じフェンスと省略注記も含め、UTF-16 長の上限を厳守する。
  out.content = truncateMarkdown(rawContent, maxChars);
  out.contentTruncated = Boolean(input.contentTruncated || out.content !== rawContent);
  out.textTruncated = Boolean(input.textTruncated || (typeof input.text === "string" && input.text.length > 20000));
  const urls = (v) => Array.isArray(v) ? [...new Set(v.slice(0, 16).map((u) => httpUrl(u)).filter(Boolean))] : [];
  out.images = urls(input.images);
  out.videos = urls(input.videos);
  out.image = httpUrl(input.image);
  return out;
}

/**
 * Markdown を UTF-16 長 maxUnits 以内に切り詰める。
 * コードポイント境界で切り、開いたままのコードフェンスを閉じ、省略注記を付ける（結果全体で maxUnits 以内）。
 */
export function truncateMarkdown(md, maxUnits) {
  const limit = Number.isFinite(maxUnits) ? Math.max(0, Math.floor(maxUnits)) : 0;
  if (typeof md !== "string") return "";
  if (md.length <= limit) return md;
  const note = "\n\n…（長いため省略しました）";
  if (limit < note.length) return note.slice(0, limit);
  let cut = limit - note.length;
  for (;;) {
    // Never split a UTF-16 surrogate pair.
    if (cut > 0 && /[\uD800-\uDBFF]/.test(md[cut - 1]) && /[\uDC00-\uDFFF]/.test(md[cut] || "")) cut--;
    const out = md.slice(0, cut);
    let open = null;
    for (const line of out.split("\n")) {
      const m = line.match(/^((?:[ \t]*>[ \t]*)*[ \t]*)((?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/);
      if (!m) continue;
      if (!open) {
        if (m[3][0] === "`" && m[4].includes("`")) continue;
        open = { char: m[3][0], size: m[3].length, prefix: m[1] + " ".repeat((m[2] || "").length) };
      } else if (m[3][0] === open.char && m[3].length >= open.size && !m[4].trim()) open = null;
    }
    const close = open ? "\n" + open.prefix + open.char.repeat(open.size) : "";
    const excess = out.length + close.length + note.length - limit;
    if (excess <= 0) return out + close + note;
    // Re-scan after reducing: the cut may now precede the opening fence.
    cut = Math.max(0, cut - excess);
  }
}
