// chrome.scripting.executeScript で直列化されるため、extractPageInfo は自己完結させる。
export const VENDOR_FILES = [
  "src/vendor/Readability.js",
  "src/vendor/turndown.js",
  "src/vendor/turndown-plugin-gfm.js",
];

export function extractPageInfo(opts = {}) {
  const { withContent = true } = opts;
  const maxChars = Number.isFinite(Number(opts.maxChars)) ? Math.max(1, Math.floor(Number(opts.maxChars))) : 100000;
  const base = document.baseURI || location.href;
  const meta = (sel) => document.querySelector(sel)?.getAttribute("content")?.trim() || "";
  const codePoints = (s, n) => Array.from(s).slice(0, n).join("");
  const normalizeUrl = (s) => {
    try {
      const u = new URL(s, base);
      u.hash = "";
      u.pathname = u.pathname.replace(/\/+$/, "") || "/";
      u.searchParams.sort();
      return u.href;
    } catch { return ""; }
  };
  const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
  const declaredUrls = [meta('meta[property="og:url"]'), canonical].filter(Boolean);
  // SPA の前ページの OG 情報を採用しない。宣言がある場合はすべて現 URL と一致すること。
  const metadataCurrent = !declaredUrls.length || declaredUrls.every((u) => normalizeUrl(u) === normalizeUrl(location.href));
  const freshOg = declaredUrls.length > 0 && metadataCurrent;
  const absolute = (s, image = false) => {
    if (!s || !String(s).trim()) return "";
    try {
      const u = new URL(s, base);
      return (image ? ["http:", "https:"] : ["http:", "https:", "mailto:"]).includes(u.protocol.toLowerCase()) ? u.href : "";
    } catch { return ""; }
  };
  const goodAuthor = (s) => {
    s = String(s || "").trim();
    return s.length <= 150 && !/^\d+$|[\r\n]|https?:\/\/|\bbot\b|フォロー|\bfollow\b/i.test(s) ? s : "";
  };
  const info = {
    source: "web",
    url: /^https?:/i.test(location.href) ? location.href : canonical || location.href,
    title: ((freshOg && meta('meta[property="og:title"]')) || document.title || location.href).slice(0, 300),
    description: ((metadataCurrent && meta('meta[name="description"]')) || (freshOg && meta('meta[property="og:description"]')) || "").slice(0, 1000),
    siteName: meta('meta[property="og:site_name"]') || location.hostname.replace(/^www\./, ""),
    image: absolute((freshOg && (meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]'))) || "", true),
    selection: codePoints(String(window.getSelection?.() || "").trim(), 5000),
    publishedAt: (metadataCurrent && (meta('meta[property="article:published_time"]') || meta('meta[name="date"]'))) || "",
    author: metadataCurrent ? goodAuthor(meta('meta[name="author"]')) : "",
    content: "",
    contentTruncated: false,
    contentError: "",
  };
  // Readability と独立した JSON-LD fallback（@graph と配列にも対応）。
  document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    if (!metadataCurrent) return;
    try {
      const visit = (value) => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) { value.forEach(visit); return; }
        const types = [].concat(value["@type"] || []);
        if (types.some((t) => /(?:^|\/)(?:Article|BlogPosting|NewsArticle|TechArticle)$/.test(t))) {
          const authors = [].concat(value.author || []).map((a) => typeof a === "string" ? a : a?.name).filter(Boolean);
          if (!info.author) info.author = goodAuthor(authors.join(", "));
          if (!info.publishedAt && typeof value.datePublished === "string") info.publishedAt = value.datePublished;
        }
        Object.values(value).forEach(visit);
      };
      visit(JSON.parse(script.textContent));
    } catch { /* 壊れた JSON-LD は無視 */ }
  });
  if (!info.author && metadataCurrent) {
    const authorNode = document.querySelector('[rel="author"], [itemprop="author"] [itemprop="name"], meta[itemprop="author"]');
    info.author = goodAuthor(authorNode?.getAttribute("content") || authorNode?.textContent || meta('meta[name="zenn:description"]').replace(/さんによる記事$/, ""));
  }
  if (!info.publishedAt && metadataCurrent) {
    const date = document.querySelector('meta[itemprop="datePublished"]')?.getAttribute("content") || document.querySelector('time[datetime]')?.getAttribute("datetime") || "";
    if (/^\d{4}-\d{2}-\d{2}/.test(date)) info.publishedAt = date;
  }
  if (!withContent) return info;
  if (document.contentType === "application/pdf" || (document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]') && (document.body?.innerText || "").trim().length < 100)) {
    info.contentError = "PDF は本文を取り出せません。リンクとメモを保存してください。";
    return info;
  }

  try {
    if (typeof Readability !== "function" || typeof TurndownService !== "function") throw new Error("ライブラリが読み込まれていません");
    // DOM の行境界を保存。textContent だけでは br / CodeMirror の行が連結される。
    const codeText = (root) => {
      const pieces = [];
      let endsInNewline = true, syntheticTrailing = false;
      const append = (s, synthetic = false) => { if (s) { pieces.push(s); endsInNewline = s.endsWith("\n"); syntheticTrailing = synthetic; } };
      const walk = (node) => {
        if (node.nodeType === 3) { append(node.nodeValue.replace(/\r\n?/g, "\n")); return; }
        if (node.nodeType !== 1) return;
        if (node.nodeName === "BR") { append("\n"); return; }
        const boundary = node !== root && (/^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TH|TR|UL)$/.test(node.nodeName) || node.matches(".line, .cm-line, .code-line") || (node.nodeName === "CODE" && node.parentElement === root && root.children.length > 1));
        if (boundary && !endsInNewline) append("\n");
        node.childNodes.forEach(walk);
        const naturalBreak = node.nextSibling?.nodeType === 3 && /^\r?\n/.test(node.nextSibling.nodeValue);
        if (boundary && !naturalBreak && (!endsInNewline || !node.textContent)) append("\n", true);
      };
      walk(root);
      const text = pieces.join("");
      return syntheticTrailing ? text.replace(/\n$/, "") : text;
    };
    const language = (pre) => {
      for (let el = pre, depth = 0; el && depth < 5; el = el.parentElement, depth++) {
        const attr = el.getAttribute("data-gmm-lang") || el.getAttribute("data-language") || el.getAttribute("data-lang");
        if (attr) return (attr.match(/[\w+#-]+/) || [""])[0];
        const hint = `${el.className || ""} ${el.querySelector("code")?.className || ""}`;
        const found = hint.match(/(?:^|\s)(?:highlight-source|language|lang|type)-([\w+#-]+)/) || hint.match(/(?:^|\s)highlight-([\w+#-]+)/) || hint.match(/(?:^|\s)sp-(javascript|typescript|jsx|tsx|css|html|json|python|ruby|bash)(?:\s|$)/) || hint.match(/brush:\s*([\w+#-]+)/);
        if (found && !/^(?:source|text|code)$/.test(found[1])) return found[1];
      }
      return "";
    };
    const pickImage = (img) => {
      for (const name of ["data-src", "data-original", "data-lazy-src"]) {
        const url = absolute(img.getAttribute(name) || "", true);
        if (url) return url;
      }
      const srcset = img.getAttribute("data-srcset") || img.getAttribute("srcset") || "";
      const candidates = srcset.split(",").map((s) => {
        const m = s.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/);
        return m ? { url: absolute(m[1], true), size: Number(m[2]) || 1 } : null;
      }).filter((c) => c?.url).sort((a, b) => b.size - a.size);
      return candidates[0]?.url || absolute(img.getAttribute("src") || "", true);
    };
    // 空 URL は new URL('', base) でページ自身になるため、先に除外する。
    const imageUrl = (img) => {
      const attrs = ["data-src", "data-original", "data-lazy-src", "srcset", "data-srcset", "src"];
      return attrs.some((a) => img.getAttribute(a)?.trim()) ? pickImage(img) : "";
    };
    const clone = document.cloneNode(true);
    const liveEls = document.querySelectorAll("*");
    const cloneEls = clone.querySelectorAll("*");
    if (liveEls.length === cloneEls.length) {
      liveEls.forEach((el, i) => {
        const pres = el.shadowRoot?.querySelectorAll("pre");
        if (!pres?.length) return;
        const lang = (el.shadowRoot.querySelector(".language-name")?.textContent || "").trim();
        pres.forEach((pre) => {
          const p = clone.createElement("pre");
          p.textContent = codeText(pre);
          p.className = lang ? `language-${lang}` : pre.className;
          cloneEls[i].appendChild(p);
        });
      });
    }
    if (!freshOg) clone.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]').forEach((el) => el.remove());
    if (!metadataCurrent) clone.querySelectorAll('meta[name="description"], meta[name="author"], meta[name="date"], meta[property^="article:"], [itemprop="author"], meta[itemprop="datePublished"], meta[itemprop="dateModified"]').forEach((el) => el.remove());
    clone.querySelectorAll(".mw-editsection, a.headerlink, .editsection, a[title^='Edit section'], script, style, noscript").forEach((el) => el.remove());
    // Readability の conditional-clean が heading-only div を広告と誤認するのを防ぐ。
    [...clone.querySelectorAll("div")].reverse().forEach((el) => {
      if (el.children.length === 1 && /^H[1-6]$/.test(el.firstElementChild.tagName) && [...el.childNodes].every((n) => n.nodeType !== 3 || !n.textContent.trim())) el.replaceWith(el.firstElementChild);
    });
    // GitHub/Gist の行番号付きソース表を、Readability が整形する前に pre にする。
    clone.querySelectorAll("table.highlight, table:has(td.blob-code)").forEach((table) => {
      const cells = [...table.querySelectorAll("td.blob-code")];
      if (!cells.length) return;
      const pre = clone.createElement("pre");
      const filename = table.getAttribute("data-tagsearch-path") || table.closest(".file, .js-file")?.querySelector(".file-info a, [data-path], .file-header a")?.textContent || table.closest("[data-path]")?.getAttribute("data-path") || location.pathname;
      const ext = filename.trim().match(/\.([a-z0-9]+)(?:[?#].*)?$/i)?.[1]?.toLowerCase();
      const langs = { js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", py: "python", rb: "ruby", rs: "rust", sh: "bash", yml: "yaml", md: "markdown", h: "c", cpp: "cpp" };
      const lang = language(table) || langs[ext] || ext || "";
      if (lang) pre.className = `language-${lang}`;
      pre.textContent = cells.map(codeText).join("\n");
      table.replaceWith(pre);
    });
    const langClasses = new Set();
    clone.querySelectorAll("pre").forEach((pre) => {
      const lang = language(pre);
      if (lang) { pre.classList.add(`language-${lang}`); langClasses.add(`language-${lang}`); }
      pre.textContent = codeText(pre);
    });
    clone.querySelectorAll("img").forEach((img) => {
      const src = imageUrl(img);
      if (src) { img.setAttribute("src", src); img.removeAttribute("srcset"); }
      else img.remove();
    });
    clone.querySelectorAll("a[href]").forEach((a) => {
      const href = absolute(a.getAttribute("href"));
      if (href) a.setAttribute("href", href);
      else a.removeAttribute("href");
    });
    const clean = (root) => {
      root.querySelectorAll("script, style, noscript, nav, footer, aside, form, iframe, svg, button").forEach((el) => el.remove());
      return root;
    };
    // 一度の線形 walk で後半を Range ごと削除。maxChars より少し多く保ち、巨大 DOM を変換しない。
    const prune = (root) => {
      const budget = Math.max(1500, Math.ceil(maxChars * 1.5));
      const walker = root.ownerDocument.createTreeWalker(root, 4);
      let used = 0, node;
      while ((node = walker.nextNode())) {
        if (used + node.length > budget) {
          const remaining = budget - used;
          let end = remaining;
          if (end > 0 && /[\uD800-\uDBFF]/.test(node.data[end - 1]) && /[\uDC00-\uDFFF]/.test(node.data[end] || "")) end--;
          const range = root.ownerDocument.createRange();
          range.setStart(node, end);
          range.setEnd(root, root.childNodes.length);
          range.deleteContents();
          return true;
        }
        used += node.length;
      }
      return false;
    };
    // 巨大サイトも Readability に渡す前に制限。main があればその本文を優先する。
    const candidateSource = clone.querySelector("article, main, [role=main]") || clone.body;
    const fallback = clean(candidateSource.cloneNode(true));
    const fallbackLength = fallback.textContent.trim().length;
    const fallbackPruned = prune(fallback);
    let readabilityPruned = false;
    if (liveEls.length > 30000) {
      clean(clone.body);
      readabilityPruned = prune(clone.body);
    }
    let article = null;
    try { article = new Readability(clone, { charThreshold: 300, classesToPreserve: [...langClasses] }).parse(); } catch { /* fallback を使う */ }
    const articleLength = (article?.textContent || "").trim().length;
    const useFallback = !article?.content || articleLength < 200 || (fallbackLength > 700 && articleLength < Math.min(fallbackLength, maxChars * 1.5) * 0.4);
    const root = document.createElement("div");
    if (useFallback) root.appendChild(fallback);
    else root.innerHTML = article.content;
    const wasPruned = (useFallback ? fallbackPruned : readabilityPruned) || prune(root);
    if (!info.description && article?.excerpt) info.description = article.excerpt.trim().slice(0, 1000);
    if (!info.author) info.author = goodAuthor(article?.byline);
    if (!info.publishedAt) info.publishedAt = article?.publishedTime || "";
    if (!freshOg && article?.title && !document.title) info.title = article.title.slice(0, 300);

    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*", linkStyle: "inlined", preformattedCode: true });
    if (typeof turndownPluginGfm !== "undefined") td.use([turndownPluginGfm.strikethrough, turndownPluginGfm.taskListItems]);
    td.addRule("gfmStrikethrough", { filter: ["del", "s", "strike"], replacement: (content) => `~~${content}~~` });
    const escape = td.escape.bind(td);
    td.escape = (s) => escape(s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    const destination = (url) => url.replace(/[()<>\s]/g, (c) => encodeURIComponent(c).replace(/\(/g, "%28").replace(/\)/g, "%29"));
    const headings = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")];
    const minHeading = headings.length ? Math.min(...headings.map((h) => Number(h.tagName[1]))) : 1;
    td.addRule("shiftHeadings", {
      filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
      replacement(content, node) {
        const level = Math.min(6, Math.max(3, Number(node.nodeName[1]) + 3 - minHeading));
        const text = content.replace(/\s+/g, " ").trim();
        return text ? `\n\n${"#".repeat(level)} ${text}\n\n` : "";
      },
    });
    td.addRule("preBlock", {
      filter: "pre",
      replacement(_c, node) {
        const text = codeText(node).replace(/\n$/, "");
        const longest = (text.match(/`+/g) || []).reduce((n, s) => Math.max(n, s.length), 0);
        const fence = "`".repeat(Math.max(3, longest + 1));
        return `\n\n${fence}${language(node)}\n${text}\n${fence}\n\n`;
      },
    });
    td.addRule("simpleTable", {
      filter: "table",
      replacement(_c, table) {
        const rows = [...table.rows].filter((r) => r.closest("table") === table);
        if (!rows.length) return "";
        const cellText = (cell) => {
          const copy = cell.cloneNode(true);
          copy.querySelectorAll("table").forEach((inner) => {
            const texts = [...inner.rows].flatMap((r) => [...r.cells].map((c) => c.textContent.trim()));
            inner.replaceWith(copy.ownerDocument.createTextNode(texts.join(" / ")));
          });
          return td.turndown(copy).replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|").trim();
        };
        const grid = [];
        let header = rows.findIndex((r) => r.parentElement.tagName === "THEAD" || [...r.cells].some((c) => c.tagName === "TH"));
        rows.forEach((row, y) => {
          grid[y] ||= [];
          let x = 0;
          [...row.cells].forEach((cell) => {
            while (grid[y][x] !== undefined) x++;
            const text = cellText(cell);
            const rs = cell.getAttribute("rowspan") === "0" ? rows.length - y : Math.min(1000, Math.max(1, cell.rowSpan));
            const cs = Math.min(1000, Math.max(1, cell.colSpan));
            for (let dy = 0; dy < rs && y + dy < rows.length; dy++) {
              grid[y + dy] ||= [];
              for (let dx = 0; dx < cs; dx++) grid[y + dy][x + dx] = dy === 0 && dx === 0 ? text : "";
            }
            x += cs;
          });
        });
        const width = Math.max(...grid.map((r) => r.length));
        if (!width) return "";
        if (width === 1) return "\n\n" + grid.map((r) => r[0]).filter(Boolean).join("\n\n") + "\n\n";
        if (header < 0) header = 0;
        const line = (r) => "| " + Array.from({ length: width }, (_, i) => r[i] || "").join(" | ") + " |";
        const caption = table.caption ? `**${td.escape(table.caption.textContent.trim())}**\n\n` : "";
        const body = grid.filter((_r, i) => i !== header);
        return "\n\n" + caption + [line(grid[header]), "| " + Array(width).fill("---").join(" | ") + " |", ...body.map(line)].join("\n") + "\n\n";
      },
    });
    td.addRule("absImages", {
      filter: "img",
      replacement(_c, node) {
        const src = imageUrl(node);
        if (!src) return "";
        const alt = td.escape((node.getAttribute("alt") || "").replace(/[\[\]\n]/g, " ").trim());
        return `![${alt}](${destination(src)})`;
      },
    });
    td.addRule("absLinks", {
      filter: (node) => node.nodeName === "A" && node.hasAttribute("href"),
      replacement(content, node) {
        content = content.replace(/^\s*#{1,6}\s+/gm, "").replace(/\s*\n+\s*/g, " ").trim();
        const href = absolute(node.getAttribute("href"));
        return content && href ? `[${content}](${destination(href)})` : content;
      },
    });
    let md = td.turndown(root).trim();
    if (md.length > maxChars || wasPruned) {
      function truncateExtractedMarkdown(md, maxUnits) {
        const limit = Number.isFinite(maxUnits) ? Math.max(0, Math.floor(maxUnits)) : 0;
        if (typeof md !== "string") return "";
        if (md.length <= limit && !wasPruned) return md;
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
      md = truncateExtractedMarkdown(md, maxChars);
      info.contentTruncated = true;
    }
    info.content = md;
    if (!md && document.querySelector("iframe")) info.contentError = "iframe 内の本文は取り出せません。元ページを開いて保存してください。";
  } catch (e) {
    info.contentError = String(e?.message || e);
  }
  return info;
}
