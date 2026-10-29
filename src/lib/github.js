// GitHub REST API の薄いラッパー。

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function encPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromB64utf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export class GitHubClient {
  constructor({ token, owner, repo, branch }) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.branch = branch || "main";
  }

  get repoPath() {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  async request(method, path, body) {
    let res;
    try {
      res = await fetch(API + path, {
        signal: AbortSignal.timeout(30000),
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
    } catch (e) {
      if (e.name === "TimeoutError" || e.name === "AbortError") throw new GitHubError("GitHub の応答がタイムアウトしました（30 秒）。時間をおいて再試行してください。", 0);
      throw e;
    }
    if (res.status === 204) return null;
    const data = await res.json().catch((e) => {
      if (e.name === "TimeoutError" || e.name === "AbortError") throw new GitHubError("GitHub の応答がタイムアウトしました（30 秒）。時間をおいて再試行してください。", 0);
      if (res.ok) throw new GitHubError("GitHub の応答を読み取れませんでした。上書きを中止しました。", res.status);
      return {};
    });
    if (!res.ok) {
      const limited = (res.status === 403 || res.status === 429) &&
        (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(data.message || "") || res.status === 429);
      throw new GitHubError(limited ? "GitHub の API 利用制限に達しました。しばらく待ってから再試行してください。" : explain(res.status, data.message), res.status);
    }
    return data;
  }

  /** 接続テスト。リポジトリ情報を返す */
  async getRepo() {
    return this.request("GET", this.repoPath);
  }

  /** ブランチ上の全ディレクトリ（basePath 配下からの相対パス）を返す */
  async listFolders(basePath = "") {
    let tree;
    try {
      tree = await this.request("GET", `${this.repoPath}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`);
    } catch (e) {
      if ((e.status === 409 || e.status === 404) && await this.isEmptyRepo()) return [];
      throw e;
    }
    this.folderWarning = tree.truncated ? "GitHub のフォルダ一覧が大きいため一部だけ取得しました（tree truncated）。フォルダの説明で候補を追加できます。" : "";
    const prefix = basePath ? basePath + "/" : "";
    return tree.tree
      .filter((t) => t.type === "tree" && t.path.startsWith(prefix))
      .map((t) => t.path.slice(prefix.length))
      .filter((p) => p && !p.split("/").some((seg) => seg.startsWith(".")))
      .sort();
  }

  async isEmptyRepo() {
    const repo = await this.getRepo();
    if (repo.size === 0) return true;
    throw new GitHubError(`ブランチ「${this.branch}」が見つかりません。リポジトリは空ではありません（既定: ${repo.default_branch || "不明"}）。ブランチ設定を確認してください。`, 404);
  }

  /** Resolve against an immutable parent tree; never confuse unreadable content with a missing file. */
  async getFileFromTree(path, rootSha, cache = new Map()) {
    let sha = rootSha;
    const segments = path.split("/");
    for (let i = 0; i < segments.length; i++) {
      if (!cache.has(sha)) cache.set(sha, await this.request("GET", `${this.repoPath}/git/trees/${encodeURIComponent(sha)}`));
      const tree = cache.get(sha);
      if (tree.truncated || !Array.isArray(tree.tree)) throw new GitHubError(`既存ファイル ${path} のツリーを完全に読み取れません。上書きを中止しました。`, 0);
      const entry = tree.tree.find((t) => t.path === segments[i]);
      if (!entry) return null;
      if (i < segments.length - 1) {
        if (entry.type !== "tree") throw new GitHubError(`保存先 ${path} がフォルダではありません。`, 0);
        sha = entry.sha;
      } else {
        if (entry.type !== "blob") throw new GitHubError(`既存ファイル ${path} を読み取れません。`, 0);
        const blob = await this.request("GET", `${this.repoPath}/git/blobs/${encodeURIComponent(entry.sha)}`);
        if (blob.encoding !== "base64" || typeof blob.content !== "string" || (blob.size > 0 && !blob.content)) {
          throw new GitHubError(`既存ファイル ${path} を読み取れません（Git Blob API は最大 100MB）。上書きを中止しました。`, 0);
        }
        try { return { sha: entry.sha, content: fromB64utf8(blob.content) }; }
        catch { throw new GitHubError(`既存ファイル ${path} の復号に失敗しました。上書きを中止しました。`, 0); }
      }
    }
    return null;
  }

  async getFile(path) {
    const ref = await this.request("GET", `${this.repoPath}/git/ref/heads/${encodeURIComponent(this.branch)}`);
    const parent = await this.request("GET", `${this.repoPath}/git/commits/${ref.object.sha}`);
    return this.getFileFromTree(path, parent.tree.sha);
  }

  /**
   * 複数ファイルを 1 コミットで書き込む。
   * files: [{ path, content }] / update: (path, oldContent|null) => newContent のような関数も可
   */
  async commitFiles(message, files, { retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      let ref;
      try {
        ref = await this.request("GET", `${this.repoPath}/git/ref/heads/${encodeURIComponent(this.branch)}`);
      } catch (e) {
        if ((e.status === 409 || e.status === 404) && await this.isEmptyRepo()) {
          // 空のリポジトリ: Contents API で最初のコミットを作る（1 ファイルずつ）
          return this.commitToEmptyRepo(message, files);
        }
        throw e;
      }
      const parentSha = ref.object.sha;
      const parent = await this.request("GET", `${this.repoPath}/git/commits/${parentSha}`);

      const entries = [];
      const cache = new Map();
      for (const f of files) {
        let content = f.content;
        if (typeof f.update === "function" || f.expectedUrl) {
          const existing = await this.getFileFromTree(f.path, parent.tree.sha, cache);
          if (existing && f.expectedUrl) {
            let existingUrl;
            try { existingUrl = JSON.parse(existing.content.match(/^url: (.+)$/m)?.[1] || "null"); } catch { /* fail closed below */ }
            if (existingUrl !== f.expectedUrl) throw new GitHubError(`保存先 ${f.path} に別の URL または識別できないファイルがあります。上書きを中止しました。`, 0);
            // A new capture may lack earlier user notes/tags or contain only a
            // truncated timeline. Never silently replace an existing bookmark.
            throw new GitHubError(`保存先 ${f.path} は保存済みです。既存の本文・メモ・タグを保護するため上書きしません。追記は GitHub で編集するか、別のフォルダに保存してください。`, 0);
          }
          if (typeof f.update === "function") content = await f.update(existing ? existing.content : null);
        }
        entries.push({ path: f.path, mode: "100644", type: "blob", content });
      }

      const tree = await this.request("POST", `${this.repoPath}/git/trees`, {
        base_tree: parent.tree.sha,
        tree: entries,
      });
      const commit = await this.request("POST", `${this.repoPath}/git/commits`, {
        message,
        tree: tree.sha,
        parents: [parentSha],
      });
      try {
        await this.request("PATCH", `${this.repoPath}/git/refs/heads/${encodeURIComponent(this.branch)}`, {
          sha: commit.sha,
        });
        return commit;
      } catch (e) {
        // 同時に別の保存が走って fast-forward できなかった場合はやり直す
        if ((e.status === 422 || e.status === 409) && attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt + Math.floor(Math.random() * 150)));
          continue;
        }
        throw e;
      }
    }
  }

  async commitToEmptyRepo(message, files) {
    let last;
    for (const f of files) {
      const content = typeof f.update === "function" ? f.update(null) : f.content;
      last = await this.request("PUT", `${this.repoPath}/contents/${encPath(f.path)}`, {
        message,
        content: b64utf8(content),
        branch: this.branch,
      });
    }
    return last?.commit;
  }

  fileUrl(path) {
    return `https://github.com/${this.owner}/${this.repo}/blob/${encodeURIComponent(this.branch)}/${encPath(path)}`;
  }
}

function explain(status, message = "") {
  switch (status) {
    case 401:
      return "GitHub トークンが無効です（401）。設定を確認してください。";
    case 403:
      return `GitHub に拒否されました（403）。トークンに Contents の書き込み権限があるか確認してください。${message}`;
    case 404:
      return "リポジトリまたはブランチが見つかりません（404）。owner / repo / branch とトークンの対象リポジトリを確認してください。";
    default:
      return `GitHub API エラー（${status}）: ${message}`;
  }
}
