// ブックマーク → Markdown ファイル（パスと本文）への変換。
import { normalizeFolder } from "./settings.js";

const INDEX_MARKER = "<!-- gitmemomark:index -->";
const pad = (n) => String(n).padStart(2, "0");

export function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${off >= 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function slugify(text, max = 50) {
  const s = String(text || "").normalize("NFKC")
    .replace(/[\x00-\x1f\x7f`]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\\/:*?"<>|#%&{}$!'@=+^~\[\]()、。，．・「」『』【】！？\s]+/g, "-")
    .replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalizeFolder([...s].slice(0, max).join("").replace(/-$/, "").toLowerCase()) || "untitled";
}

/** URL hash prevents collisions; X paths remain stable across days. */
export async function buildPath(item, folder, basePath = "", now = new Date()) {
  let name;
  if (item.source === "x" && item.tweetId) {
    name = `x_${slugify(item.authorHandle || "user", 20)}_${item.tweetId}`;
  } else {
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const url = new URL(item.url);
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(url.href));
    const hash = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("").slice(0, 12);
    let title = item.title;
    if (!title || title === item.url) {
      try { title = decodeURIComponent(url.hostname + url.pathname); }
      catch { title = url.hostname + url.pathname; }
    }
    name = `${date}_${slugify(url.hostname.replace(/^www\./, "").replace(/\./g, "-"), 30)}_${slugify(title, 40)}_${hash}`;
  }
  return [normalizeFolder(basePath), normalizeFolder(folder), `${name}.md`].filter(Boolean).join("/");
}

// JSON escapes C0 and lone surrogates; YAML also requires DEL/C1 escapes.
const y = (v) => JSON.stringify(v ?? "").replace(/[\u007f-\u009f]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.href.replace(/[<>\r\n]/g, (c) => encodeURIComponent(c)) : "";
  } catch { return ""; }
}
const imageMarkdown = (src) => safeHttpUrl(src) ? `![](<${safeHttpUrl(src)}>)` : "";

export function buildMarkdown(item, { folder, tags = [], memo = "", classifiedBy = "manual", savedAt = new Date() }) {
  const isX = item.source === "x";
  const fm = ["---", `title: ${y(item.title)}`, `url: ${y(item.url)}`, `source: ${isX ? "x" : "web"}`];
  if (item.siteName) fm.push(`site: ${y(item.siteName)}`);
  if (item.author) fm.push(`author: ${y(item.author)}`);
  if (isX) {
    if (item.authorHandle) fm.push(`author_handle: ${y(item.authorHandle)}`);
    if (item.tweetId) fm.push(`tweet_id: ${y(item.tweetId)}`);
  } else if (item.description) fm.push(`description: ${y(item.description.replace(/\s+/g, " ").slice(0, 300))}`);
  if (item.publishedAt) fm.push(`${isX ? "posted_at" : "published_at"}: ${y(item.publishedAt)}`);
  fm.push(`folder: ${y(folder)}`, `tags: [${tags.map(y).join(", ")}]`,
    `classified_by: ${y(classifiedBy)}`, `saved_at: ${y(localIso(savedAt))}`, "---", "");
  const quoteLines = (text, prefix = "> ") => text.split("\n").map((l) => `${prefix}${l}`.trimEnd()).join("\n");
  const body = [`# ${(item.title || item.url || "Untitled").replace(/[\r\n]+/g, " ")}`, ""];
  if (safeHttpUrl(item.url)) body.push(`<${safeHttpUrl(item.url)}>`, "");
  if (isX) {
    const who = [item.author, item.authorHandle && `@${item.authorHandle.replace(/^@/, "")}`].filter(Boolean).join(" ");
    if (who) body.push(`**${who}**`, "");
    if (item.text) body.push(quoteLines(item.text), "");
    if (item.selection) body.push("## 抜粋", "", quoteLines(item.selection), "");
    if (item.textTruncated) body.push("※タイムライン表示のため本文が途中までの可能性があります", "");
    if (item.quoted) body.push("引用ポスト:", "", quoteLines(item.quoted, "> > "), "");
    body.push(...(item.images || []).slice(0, 16).map(imageMarkdown).filter(Boolean), "");
    if (item.videos?.length) {
      body.push("🎞 動画/GIF あり", "", ...item.videos.slice(0, 16).map(imageMarkdown).filter(Boolean), "");
    }
  } else {
    if (item.selection) body.push("## 抜粋", "", quoteLines(item.selection), "");
    else if (item.description && !item.content) body.push(quoteLines(item.description), "");
    const images = [...new Set([...(item.images || []), ...(!item.content && item.image ? [item.image] : [])])];
    body.push(...images.slice(0, 16).map(imageMarkdown).filter(Boolean));
    if (images.length) body.push("");
  }
  if (memo) body.push("## メモ", "", memo, "");
  if (!isX && item.content) body.push("## 本文", "", item.content, "");
  if (!isX && item.contentTruncated) body.push("※本文は最大文字数で切り詰められています。", "");
  if (item.contentError || item.extractError) body.push(`※本文抽出の注意: ${(item.contentError || item.extractError).replace(/[\r\n]+/g, " ")}`, "");
  // Preserve literal whitespace inside extracted code blocks and user notes.
  return fm.join("\n") + "\n" + body.join("\n");
}

/** Replace an existing entry at the same path, rather than retaining stale titles. */
export function updateIndex(existing, { path, basePath, item, folder, savedAt = new Date() }) {
  const rel = basePath && path.startsWith(basePath + "/") ? path.slice(basePath.length + 1) : path;
  const date = `${savedAt.getFullYear()}-${pad(savedAt.getMonth() + 1)}-${pad(savedAt.getDate())}`;
  const title = (item.title || item.url).replace(/[\\\[\]\r\n]/g, " ").slice(0, 120);
  const target = encodeURI(rel).replace(/[()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  // Only replace rows explicitly owned by this extension. A user may reference
  // the same file in their own notes; never delete those merely by matching URL.
  const entryMarker = `<!-- gitmemomark:entry ${encodeURIComponent(rel).replace(/-/g, "%2D")} -->`;
  const line = `- ${date} ${item.source === "x" ? "𝕏" : "🌐"} [${title}](<${target}>) — \`${folder}\` ${entryMarker}`;
  let text = existing || `# Bookmarks\n\nGitMemoMark で保存したブックマークの一覧です（新しい順）。\n\n${INDEX_MARKER}\n`;
  text = text.split("\n").filter((l) => !l.endsWith(entryMarker)).join("\n");
  if (!text.includes(INDEX_MARKER)) text = text.replace(/\s*$/, `\n\n${INDEX_MARKER}\n`);
  return text.replace(INDEX_MARKER, `${INDEX_MARKER}\n${line}`);
}
