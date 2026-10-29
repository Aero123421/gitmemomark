# Privacy / プライバシー

This describes the current developer preview source, not a promise about external providers. Review it again after updates. GitMemoMark saves content to a GitHub repository chosen by you; optional TypeSafe Jev classification sends data to a separate provider.

## Local storage

- Settings, GitHub token, and Jev API key are stored in `chrome.storage.local`, not Chrome Sync. The service worker restricts that storage to trusted extension contexts; X content scripts receive only public save-mode/X preferences.
- Local storage is **not an encrypted secrets vault**. Anyone with sufficient access to your OS, browser profile, or extension debugging tools may obtain the credentials.
- `chrome.storage.session` temporarily holds pending extracted content, repository folder caches, and recent X-save identifiers. Pending dialogs can contain page text before you save. Session storage is cleared by Chrome on browser restart / extension disable or reload; this is not secure erasure.
- Theme preferences may be stored locally by the release UI. They are not a reason to send page content to a provider.

## GitHub

Using save sends Markdown (title, URL, source metadata, optional extracted body, selections, images as URLs, tags and notes), generated paths, an index when enabled, and a descriptive commit message to `https://api.github.com`. The configured token is sent in the Authorization header. Repository and folder lookup / connection testing also contact GitHub, even without a save. Opening a generated GitHub link contacts GitHub normally.

**Public repository means public content.** Repository paths, folder names and commit titles can themselves reveal private information. Deleting a file does not remove Git history, forks, clones or provider backups. The extension does not rewrite history. It refuses to replace an existing bookmark at the same path; changing a title/date/folder may still create another copy. Review repository visibility and what you save, including authenticated pages and URL query parameters.

GitHub's own handling is governed by its [privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

## TypeSafe Jev (optional, OFF by default)

When enabled with a key and candidate folders, automatic classification can occur **as soon as the save popup opens**, before pressing Save. It also runs during quick-save or deliberate reclassification. A matching domain rule can avoid Jev classification. Canceling the popup does not undo an earlier request.

Requests to `POST https://api.typesafe.ai/v1/systemone` include:

- Title, full URL, site name, description, selected text, and a user note when present.
- Candidate folder names and their descriptions (potentially sensitive repository metadata).
- Only when **“send content to Jev”** is separately enabled: the first 2,000 UTF-16 units of X text and/or extracted body combined.
- Model and classification questions; the API key is sent in the Authorization header.

**Disabling body sharing does not disable metadata or selected-text sharing.** Disabling Web body saving does not remove selections, descriptions or notes. Turning off body saving after classification cannot recall data already sent. The explicit reclassification control can send the current edited title/note. The connection-test button sends a synthetic connection-test string, not a page.

Excluded domains and their subdomains are checked before Jev network requests. To avoid all classification sharing, keep Jev disabled. Consult [TypeSafe](https://typesafe.ai/) for its current privacy, retention and API terms; this project cannot promise provider retention or model-training practices.

## Chrome permissions and page access

- `storage`: settings, credentials and session caches.
- `contextMenus`: save page/selection/link/image commands.
- `activeTab` + `scripting`: user-triggered extraction and feedback on the active page, with bundled Readability/Turndown (no remote library download).
- GitHub and TypeSafe host permissions: API calls described above. TypeSafe permission is declared even when Jev is disabled.
- X / twitter.com host permissions and content scripts: observe rendered posts, insert save buttons, and optionally react to bookmark clicks. Enabling bookmark synchronization can automatically save content to GitHub. This is not a full X account/bookmark export.

The source review found no independent analytics, advertising SDK, or telemetry endpoint in this version. This does **not** mean “no network activity”: API requests, the pages you browse, and images/links opened by Markdown viewers have their own network and privacy effects. No claim is made about the browsing site's own collection.

## Delete data / revoke access

1. Disable Jev and X bookmark synchronization to stop those future operations.
2. Clear saved credentials/settings or remove the extension to remove its local storage; revoke the GitHub token in [GitHub settings](https://github.com/settings/tokens) and the Jev key in [TypeSafe console](https://console.typesafe.ai/keys). Removing the extension alone does not revoke keys.
3. Delete repository content separately if desired. For leaked secrets, rotate them first; removing content or rewriting Git history does not guarantee deletion of copies.
4. Contact the provider for provider-side deletion requests. GitMemoMark does not operate a backend or deletion service for GitHub/TypeSafe data.

Do not attach real tokens, authenticated profile captures, private article text, repository dumps, or sensitive URLs to public issues. See [SECURITY.md](SECURITY.md) for confidential reporting.
