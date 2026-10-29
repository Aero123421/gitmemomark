import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { buildPath, buildMarkdown, slugify, updateIndex, safeHttpUrl } from '../src/lib/markdown.js';
import { normalizeFolder, sanitizeItem, clampMaxChars, truncateMarkdown, publicSettings, DEFAULT_SETTINGS } from '../src/lib/settings.js';
import { GitHubClient } from '../src/lib/github.js';
import { classifyFolder, selectCandidateFolders } from '../src/lib/jev.js';
import { extractPageInfo } from '../src/lib/extract.js';

globalThis.crypto ||= webcrypto;
const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = async () => { throw new Error('Live network is forbidden in tests'); }; });
afterEach(() => { globalThis.fetch = originalFetch; });

// Entirely synthetic fixtures; no live account, credentials or article captures.
const web = { source: 'web', url: 'https://example.org/one', title: 'Synthetic bookmark' };
const tweet = { source: 'x', url: 'https://x.com/example/status/123', authorHandle: 'example', tweetId: '123', title: 'Synthetic post', text: 'Synthetic text' };
const date = new Date(2026, 9, 22, 12);
const gh = () => new GitHubClient({ owner: 'synthetic-owner', repo: 'synthetic-repo', branch: 'main' });
const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const note = '\n\n…（長いため省略しました）';
const wellFormed = (text) => {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      assert.ok(text.charCodeAt(++i) >= 0xdc00 && text.charCodeAt(i) <= 0xdfff, 'split high surrogate');
    } else assert.ok(c < 0xdc00 || c > 0xdfff, 'unpaired low surrogate');
  }
};

// Follow the fence structure rather than checking only for any closing ticks.
function assertClosedBeforeNote(text) {
  assert.ok(text.endsWith(note));
  let open = null;
  for (const line of text.slice(0, -note.length).split('\n')) {
    const match = line.match(/^(?:[ \t]*>[ \t]*)*[ \t]*(?:[-+*][ \t]+)?(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    if (!open) open = { char: match[1][0], size: match[1].length };
    else if (match[1][0] === open.char && match[1].length >= open.size && !match[2].trim()) open = null;
  }
  assert.equal(open, null, 'truncation note must be outside the fenced code');
}

test('URL hash distinguishes title-prefix collisions and URL-derived titles', async () => {
  const sameTitle = 'shared-prefix-'.repeat(10);
  const a = await buildPath({ ...web, title: sameTitle + '1' }, 'tech', '', date);
  const b = await buildPath({ ...web, url: 'https://example.org/two', title: sameTitle + '2' }, 'tech', '', date);
  assert.notEqual(a, b);
  assert.match(a, /[a-f0-9]{12}\.md$/);
  const derived = await buildPath({ ...web, title: web.url }, 'tech', '', date);
  assert.ok(!derived.includes('untitled'));
  assert.equal(a, await buildPath({ ...web, title: sameTitle + '1' }, 'tech', '', date));
});

test('X paths stay stable across dates but folder changes create another path', async () => {
  const a = await buildPath(tweet, 'tech', '', date);
  assert.equal(a, await buildPath(tweet, 'tech', '', new Date(2027, 0, 1)));
  assert.notEqual(a, await buildPath(tweet, 'other', '', date));
});

test('normalizeFolder and slugify neutralize traversal, controls and reserved names', () => {
  assert.equal(normalizeFolder('/../CON./aux.txt / a\x01b` /../LPT9 /foo... / NUL'), '_CON/_aux.txt/ab/_LPT9/foo/_NUL');
  assert.equal(slugify('CON'), '_con');
  assert.equal(slugify('hi\x00`there...'), 'hithere');
  assert.equal(clampMaxChars(900000), 300000);
  assert.equal(clampMaxChars(2), 1000);
  assert.equal(clampMaxChars(NaN), 100000);
});

test('sanitizeItem rejects unsafe URL schemes, embedded auth and inconsistent X identity', () => {
  for (const url of ['javascript:void(0)', 'data:text/html,x', 'file:///synthetic', 'chrome://extensions', 'https://user:password@example.org/']) {
    assert.throws(() => sanitizeItem({ ...web, url }));
  }
  for (const change of [{ tweetId: '1/2' }, { authorHandle: 'a/b' }, { url: 'https://x.com/example/status/124' }]) {
    assert.throws(() => sanitizeItem({ ...tweet, ...change }));
  }
  assert.throws(() => sanitizeItem(null));
  assert.throws(() => sanitizeItem([]));
});

test('sanitizeItem bounds supported fields and strips unknown secret-looking properties', () => {
  const item = sanitizeItem({ ...web, title: 'a'.repeat(301), text: 'b'.repeat(25000), unsupported: 'never retain',
    images: ['data:x', ...Array.from({ length: 20 }, (_, i) => `https://example.org/${i}`)] });
  assert.equal(item.title.length, 300);
  assert.equal(item.text.length, 20000);
  assert.equal(item.textTruncated, true);
  assert.equal(item.unsupported, undefined);
  assert.ok(item.images.length <= 16);
  assert.ok(item.images.every(url => url.startsWith('https:')));
  assert.deepEqual(Object.keys(publicSettings(DEFAULT_SETTINGS)).sort(), ['saveMode', 'x']);
});

test('YAML escapes C0/C1 and lone surrogates; generated image URLs are HTTP-only', () => {
  const md = buildMarkdown({ ...web, title: 'A\x00\x7f\x85\ud800\n---\ninjected: yes',
    images: ['https://example.org/a (b).jpg', 'data:image/a', 'javascript:alert(1)'] }, { folder: 'tech', tags: ['a\nb', 'quote"'] });
  assert.ok(md.includes('\\u0000\\u007f\\u0085\\ud800'));
  assert.ok(md.includes('\\n---\\ninjected: yes'));
  assert.ok(md.includes('![](<https://example.org/a%20(b).jpg>)'));
  assert.ok(!md.includes('data:image') && !md.includes('javascript:'));
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpUrl('https://example.org/<x>'), 'https://example.org/%3Cx%3E');
});

test('Markdown assembly preserves literal blank lines inside fenced code', () => {
  const content = '```text\nfirst\n\n\n\nlast\n```';
  const md = buildMarkdown({ ...web, content }, { folder: 'tech' });
  assert.ok(md.includes(content), 'literal code whitespace must not be globally collapsed');
});

test('INDEX replaces owned entries, escapes targets and preserves manual same-link text', () => {
  const opts = { path: 'a/a (b).md', basePath: '', item: web, folder: 'a', savedAt: date };
  const manual = '- My own explanation [manual](<a/a%20%28b%29.md>) — keep me\n';
  const one = updateIndex(manual, opts);
  const two = updateIndex(one, { ...opts, item: { ...web, title: 'New title' } });
  assert.ok(two.includes(manual.trim()));
  assert.equal(two.split('\n').filter(line => line.includes('gitmemomark:entry ')).length, 1);
  assert.ok(two.includes('New title'));
  assert.ok(two.includes('a/a%20%28b%29.md'));
});

test('truncation leaves short input unchanged and respects tiny UTF16 budgets', () => {
  assert.equal(truncateMarkdown('unchanged', 9), 'unchanged');
  for (const limit of [0, 1, 2, 5, note.length - 1, note.length, 40]) {
    const out = truncateMarkdown('😀'.repeat(100), limit);
    assert.ok(out.length <= limit);
    wellFormed(out);
  }
});

test('truncation closes arbitrarily long fences and keeps the full suffix within budget', () => {
  for (const size of [3, 15, 16, 32, 100, 600]) {
    for (const char of ['`', '~']) {
      const fence = char.repeat(size);
      const out = truncateMarkdown(fence + 'text\n' + 'synthetic '.repeat(1000), 1000);
      assert.ok(out.length <= 1000, `size ${size}`);
      assertClosedBeforeNote(out);
    }
  }
});

test('truncation closes quoted/list fences without splitting Unicode', () => {
  for (const prefix of ['> ', '> > ', '- ']) {
    const out = truncateMarkdown(prefix + '`'.repeat(24) + 'text\n' + '😀'.repeat(1000), 1000);
    assert.ok(out.length <= 1000);
    wellFormed(out);
    assertClosedBeforeNote(out);
  }
});

test('sanitize content has a strict UTF16 cap, including former 128-unit slack, and is idempotent', () => {
  const settings = { web: { maxChars: 1000 } };
  for (const content of ['a'.repeat(1001), '😀'.repeat(520), '`'.repeat(32) + 'text\n' + '😀'.repeat(1000)]) {
    const once = sanitizeItem({ ...web, content }, settings);
    assert.ok(once.content.length <= 1000);
    assert.equal(once.contentTruncated, true);
    wellFormed(once.content);
    assert.deepEqual(sanitizeItem(once, settings), once);
  }
});

// Minimal synthetic DOM: exercise the real serialized executeScript function and
// final truncation, without a DOM package, copyrighted pages or a Chrome profile.
function extractSynthetic(markdown, maxChars, pruned = false) {
  let document;
  const node = () => ({
    textContent: 'synthetic fallback '.repeat(60), childNodes: [],
    ownerDocument: document, querySelectorAll: () => [], querySelector: () => null,
    cloneNode: () => node(), appendChild() {},
  });
  document = {
    baseURI: web.url, title: web.title, contentType: 'text/html',
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => node(),
    createTreeWalker: () => {
      let visited = false;
      return { nextNode: () => pruned && !visited++ ? { length: 2000, data: 'x'.repeat(2000) } : null };
    },
    createRange: () => ({ setStart() {}, setEnd() {}, deleteContents() {} }),
    cloneNode: () => ({ body: node(), querySelector: () => null, querySelectorAll: () => [] }),
  };
  class SyntheticTurndown {
    escape(value) { return value; }
    addRule() {}
    turndown() { return markdown; }
  }
  class SyntheticReadability { parse() { return null; } }
  return runInNewContext(`(${extractPageInfo.toString()})({ maxChars: ${maxChars} })`, {
    document, location: { href: web.url, hostname: 'example.org' },
    window: { getSelection: () => '' }, URL,
    Readability: SyntheticReadability, TurndownService: SyntheticTurndown,
  });
}

test('serialized extraction uses UTF16 budget and closes >15-backtick fences', () => {
  for (const markdown of ['😀'.repeat(800), '`'.repeat(32) + 'text\n' + '😀'.repeat(1200)]) {
    const extracted = extractSynthetic(markdown, 1000);
    assert.equal(extracted.contentError, '');
    assert.equal(extracted.contentTruncated, true);
    assert.ok(extracted.content.length <= 1000);
    wellFormed(extracted.content);
    assertClosedBeforeNote(extracted.content);
    assert.equal(sanitizeItem({ ...web, ...extracted }, { web: { maxChars: 1000 } }).content, extracted.content);
  }
});

test('DOM pruning still marks short extracted output as truncated within its final budget', () => {
  const extracted = extractSynthetic('synthetic short output', 1000, true);
  assert.equal(extracted.contentError, '');
  assert.equal(extracted.contentTruncated, true);
  assert.equal(extracted.content, 'synthetic short output' + note);
  assert.ok(extracted.content.length <= 1000);
});

function parentTreeFetch(blob, { truncated = false, entry = true } = {}) {
  const writes = [];
  globalThis.fetch = async (url, opts) => {
    const path = new URL(url).pathname;
    if (opts.method !== 'GET') { writes.push({ path, body: JSON.parse(opts.body) }); return reply({ sha: 'new' }); }
    if (path.includes('/git/ref/')) return reply({ object: { sha: 'parent' } });
    if (path.endsWith('/git/commits/parent')) return reply({ tree: { sha: 'root' } });
    if (path.endsWith('/git/trees/root')) return reply({ truncated, tree: entry ? [{ path: 'INDEX.md', type: 'blob', sha: 'existing' }] : [] });
    if (path.endsWith('/git/blobs/existing')) return reply(blob);
    throw new Error('Unexpected mock request: ' + path);
  };
  return writes;
}
const encoded = (text) => ({ encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') });

test('large INDEX is read from immutable parent blob, not the Contents API', async () => {
  const old = '# Synthetic index\n' + 'a'.repeat(1100000);
  const writes = parentTreeFetch(encoded(old));
  await gh().commitFiles('synthetic', [{ path: 'INDEX.md', update: content => content + '\nnew' }]);
  assert.equal(writes[0].body.base_tree, 'root');
  assert.equal(writes[0].body.tree[0].content, old + '\nnew');
  assert.ok(!writes.some(write => write.path.includes('/contents/')));
});

test('unreadable blobs, corrupt base64/UTF8 and incomplete trees fail closed without writes', async () => {
  for (const blob of [
    { encoding: 'none', size: 2000000, content: '' },
    { encoding: 'base64', size: 4, content: '' },
    { encoding: 'base64', content: 'not valid base64!' },
    { encoding: 'base64', content: Buffer.from([0xff]).toString('base64') },
  ]) {
    const writes = parentTreeFetch(blob);
    await assert.rejects(() => gh().commitFiles('synthetic', [{ path: 'INDEX.md', update: old => old + 'new' }]));
    assert.equal(writes.length, 0);
  }
  const writes = parentTreeFetch(encoded('old'), { truncated: true });
  await assert.rejects(() => gh().commitFiles('synthetic', [{ path: 'INDEX.md', update: old => old + 'new' }]));
  assert.equal(writes.length, 0);
});

test('existing bookmark is never overwritten, including same-URL notes or unknown front matter', async () => {
  for (const content of [
    `---\nurl: ${JSON.stringify(web.url)}\n---\n## My previous notes\nKeep this text`,
    '---\nurl: "https://example.org/other"\n---',
    'This manually created file has no URL front matter',
  ]) {
    const writes = parentTreeFetch(encoded(content));
    await assert.rejects(() => gh().commitFiles('synthetic', [{ path: 'INDEX.md', content: 'replacement', expectedUrl: web.url }]));
    assert.equal(writes.length, 0);
  }
});

test('missing blob differs from unreadable blob: only absence allows new-file creation', async () => {
  const writes = parentTreeFetch(null, { entry: false });
  await gh().commitFiles('synthetic', [{ path: 'INDEX.md', content: 'new synthetic file', expectedUrl: web.url }]);
  assert.equal(writes[0].body.tree[0].content, 'new synthetic file');
});

test('Jev candidates are capped, deduplicated and descriptions preferred', () => {
  const folders = Array.from({ length: 300 }, (_, i) => ({ name: 'f' + i, description: i === 299 ? 'preferred' : '' }));
  folders.push({ name: 'a/b/c/d', description: 'too deep' });
  const candidates = selectCandidateFolders(folders);
  assert.equal(candidates.length, 255);
  assert.equal(candidates[0].name, 'f299');
  assert.ok(!candidates.some(folder => folder.name === 'a/b/c/d'));
  assert.equal(selectCandidateFolders([{ name: 'a' }, { name: 'a' }]).length, 1);
});

test('Jev excludes body by default, sends metadata/selection/note, and uses confidence not probability', async () => {
  let body;
  globalThis.fetch = async (url, opts) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.ok(opts.signal);
    body = JSON.parse(opts.body);
    return reply({ answers: { folder: { choice: 'tech', confidence: .8, probabilities: { tech: .01 } }, fits: { noul: .7 } } });
  };
  const result = await classifyFolder({ threshold: .5 }, { ...web, text: 'body-only-canary', content: 'body-only-canary', selection: 'synthetic selection', memo: 'synthetic note' }, [{ name: 'tech' }]);
  assert.equal(result.folder, 'tech');
  assert.equal(body.state.bookmark.selection, 'synthetic selection');
  assert.equal(body.state.bookmark.user_note, 'synthetic note');
  assert.equal(body.state.bookmark.text, undefined);
  assert.ok(!JSON.stringify(body).includes('body-only-canary'));
  await classifyFolder({ sendContent: true }, { ...web, content: 'x'.repeat(3000) }, [{ name: 'tech' }]);
  assert.equal(body.state.bookmark.text.length, 2000);
});

test('Jev excluded domains and subdomains never call fetch', async () => {
  for (const url of ['https://example.org/a', 'https://sub.example.org/a']) {
    const result = await classifyFolder({ excludeDomains: 'example.org' }, { ...web, url }, [{ name: 'tech' }]);
    assert.equal(result.excluded, true);
  }
});

test('provider timeout and rate-limit failures have actionable errors', async () => {
  globalThis.fetch = async () => { throw new DOMException('synthetic timeout', 'TimeoutError'); };
  await assert.rejects(() => gh().getRepo(), /30 秒/);
  await assert.rejects(() => classifyFolder({}, web, [{ name: 'tech' }]), /15 秒/);
  globalThis.fetch = async () => reply({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' });
  await assert.rejects(() => gh().getRepo(), /利用制限/);
});
