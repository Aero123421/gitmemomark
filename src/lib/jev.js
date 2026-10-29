// TypeSafe Jev（System One モデル）でブックマークの保存先フォルダを判定する。
// API: POST https://api.typesafe.ai/v1/systemone
// docs: https://docs.typesafe.ai/api.md , https://docs.typesafe.ai/primitives/choice.md

import { isExcludedDomain } from "./settings.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export function selectCandidateFolders(folders) {
  return [...new Map(folders.filter((f) => f.name && f.name.split("/").length <= 3).map((f) => [f.name, f])).values()]
    .sort((a, b) => Number(Boolean(b.description)) - Number(Boolean(a.description)) || a.name.localeCompare(b.name))
    .slice(0, 255);
}

export class JevError extends Error {}

async function callSystemOne({ apiKey, model }, state, questions) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      signal: AbortSignal.timeout(15000),
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: model || "jev-latest", state, questions }),
    });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") throw new JevError("Jev の応答がタイムアウトしました（15 秒）。未仕分けフォルダを使います。");
    throw e;
  }
  const data = await res.json().catch((e) => {
    if (e.name === "TimeoutError" || e.name === "AbortError") throw new JevError("Jev の応答がタイムアウトしました（15 秒）。未仕分けフォルダを使います。");
    if (res.ok) throw new JevError("Jev の応答を読み取れませんでした。未仕分けフォルダを使います。");
    return {};
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new JevError(`Jev API キーが無効です（${res.status}）`);
    }
    const detail = Array.isArray(data.detail)
      ? data.detail.map((d) => d.msg).join(", ")
      : data.detail || data.message || "";
    throw new JevError(`Jev API エラー（${res.status}）${detail}`);
  }
  return data;
}

/**
 * フォルダを自動判定する。
 * @param {object} jevSettings { apiKey, model, threshold }
 * @param {object} item 保存しようとしているブックマーク
 * @param {{name:string, description:string}[]} folders 候補フォルダ（未仕分けフォルダは含めない）
 * @returns {Promise<{folder: string|null, confidence: number, fits: number, probabilities: object}>}
 *   folder が null のときは「どこにも当てはまらない / 自信がない」= 未仕分け行き
 */
export async function classifyFolder(jevSettings, item, folders) {
  if (isExcludedDomain(item.url, jevSettings.excludeDomains)) {
    return { folder: null, confidence: 0, fits: 0, probabilities: {}, excluded: true, reason: "このドメインは Jev への送信対象外です。" };
  }
  folders = selectCandidateFolders(folders);
  if (!folders.length) {
    return { folder: null, confidence: 0, fits: 0, probabilities: {}, reason: "候補フォルダがありません" };
  }

  const state = {
    bookmark: {
      title: item.title || "",
      url: item.url || "",
      site: item.siteName || "",
      description: item.description || "",
      selection: item.selection || "",
      ...(jevSettings.sendContent ? { text: [item.text, item.content].filter(Boolean).join("\n\n").slice(0, 2000) } : {}),
      user_note: item.memo || undefined,
    },
    folders: folders.map((f) => (f.description ? `${f.name}: ${f.description}` : f.name)),
  };

  const criteria = Object.create(null);
  for (const f of folders) {
    criteria[f.name] = f.description || null;
  }

  const questions = {
    folder: {
      type: "choice",
      instructions:
        "The user is saving `bookmark` into a personal bookmark collection organized by topic folders. " +
        "Which folder is the best place to file it, based on its subject matter?",
      criteria,
    },
    fits: {
      type: "noul",
      instructions:
        "At least one of the folders listed in `folders` is a clearly appropriate place for `bookmark` based on its subject matter.",
    },
  };

  const res = await callSystemOne(jevSettings, state, questions);
  const choice = res.answers?.folder;
  const fits = res.answers?.fits?.noul ?? 0;
  const confidence = Number(choice?.confidence ?? 0);
  const threshold = Math.max(0, Math.min(1, Number(jevSettings.threshold ?? 0.5)));

  const ok = choice && folders.some((f) => f.name === choice.choice) && fits >= 0.5 && confidence >= threshold;
  return {
    folder: ok ? choice.choice : null,
    suggestion: choice?.choice ?? null,
    confidence,
    fits,
    probabilities: choice?.probabilities || {},
    model: res.model,
  };
}

/** 接続テスト用 */
export async function pingJev(jevSettings) {
  const res = await callSystemOne(jevSettings, "GitMemoMark connection test", {
    ok: { type: "noul", instructions: "This text is a connection test." },
  });
  return res.model;
}
