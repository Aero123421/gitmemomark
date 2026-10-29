# Contributing

Thanks for helping with this developer preview. Discuss substantial changes in an issue first; use [private reporting](SECURITY.md) for vulnerabilities. Contributions intentionally submitted for inclusion are under [Apache-2.0](LICENSE), unless explicitly stated otherwise. Preserve third-party licenses and disclose modifications to vendored components in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Local setup

```sh
git clone https://github.com/Aero123421/gitmemomark.git
cd gitmemomark
npm test
```

Use Node.js 22 or newer (CI: 22 and 24). There are no runtime/test npm dependencies and no build step. `npm install` is unnecessary. Load the root folder unpacked using the [README instructions](README.md); reload the extension after edits and refresh X tabs to replace content scripts.

Tests use `node:test`, synthetic fixtures, relative module imports and mocked `fetch`. They must not depend on a host-specific absolute path, a browser profile, real credentials, licensed article snapshots, or live network availability. Restore mocked globals after each test. Add a regression that captures the **desired** contract, not an assertion that blesses a known bug. Do not skip failing safety tests to get green CI.

## Pull request checklist

- Explain the behavior changed and any privacy, permissions, data-format or compatibility implications.
- Run `npm test`; report Node version and results. Add focused regressions for pure logic and failure paths.
- Never commit `.env`, keys/tokens, authenticated profiles, debug dumps, private bookmarks or copyrighted page captures. `.gitignore` is a guardrail, not a secret scanner.
- Preserve browser-serializable extraction: `extractPageInfo` runs through `chrome.scripting.executeScript` and cannot close over module imports.
- Do not silently overwrite existing bookmark content, treat unreadable blobs as absent, or remove user-authored index lines.
- Update [PRIVACY.md](PRIVACY.md) whenever data collection, storage, transmission or permissions change.

## Manual release checks (not covered by Node tests)

Use synthetic content, a disposable private repository, and least-privilege expiring keys. Never publish credentials or browser-profile artifacts with evidence.

- Load unpacked in current desktop Chrome; check first-run setup, settings persistence and extension reload.
- Check popup and settings in light, dark and system modes, keyboard navigation, focus, narrow viewport and reduced motion.
- Save a synthetic Web page with headings, tables, code (including long fences), Unicode, links/images and a selection. Confirm truncation notes and previews.
- Exercise ask/quick/shortcut/context-menu actions. Confirm cancel does not write to GitHub; with Jev enabled, classify may already have sent metadata.
- With explicit consent, verify Jev off, metadata-only, body opt-in, excluded domains, and errors using a disposable key.
- With explicit consent, test GitHub authenticated writes, existing-path refusal, index preservation, concurrent saves, API failure, and partially initialized empty repositories. Inspect actual commits and notes, not just success badges.
- With an authorized X account, check timeline/detail/quote/media, navigation, bookmark opt-in and reloading. Authenticated X and real authenticated API-write E2E coverage have not yet been completed for this preview; record results before claiming otherwise.
- Release screenshots must use synthetic data, contain no credentials/private identifiers, and be newly generated as `screenshots/release-*.png`. Design mocks and stale screenshots are not release evidence.
- Ensure GitHub private vulnerability reporting is enabled and the [reporting link](https://github.com/Aero123421/gitmemomark/security/advisories/new) works.

The initial empty-repository flow uses multiple Contents API writes and is not atomic. The pure-module tests cannot validate Chrome permissions, real provider behavior, or authenticated X layout; do not describe them as end-to-end coverage.
