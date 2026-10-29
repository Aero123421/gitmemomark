# Security policy

## Supported versions

GitMemoMark is a developer preview. Security fixes target the latest source on the default branch; older snapshots are not separately maintained. There is no promised response SLA or completed external security audit.

## Report privately

Please use [GitHub private vulnerability reporting](https://github.com/Aero123421/gitmemomark/security/advisories/new). Do **not** open a public issue for an exploitable vulnerability, leaked credential, or private page/repository data.

Private vulnerability reporting is enabled for this repository. If the link is unavailable, do not post sensitive details publicly; ask the maintainer for a private contact method without disclosing the vulnerability.

Include the affected version, browser/OS, impact, and minimal reproduction using synthetic content and a disposable repository. Redact tokens, API keys, authenticated cookies, browser profiles and personal/private content. Allow time for triage and a fix before coordinated public disclosure.

## User precautions

- Use a fine-grained GitHub token limited to one repository and Contents read/write, with an expiry. Keep save repositories private unless you intend to publish every saved field.
- Prefer a disposable test repository while evaluating the preview. Connection tests and mocked unit tests do not establish end-to-end write safety.
- Review [PRIVACY.md](PRIVACY.md), especially popup-triggered optional Jev sharing and Git history retention.
- Credentials are local browser-profile data, not encrypted secrets-vault storage. Do not share your profile or debug exports.
- If a secret leaks, revoke/rotate it immediately; deleting a commit or issue is insufficient.

Authentication, third-party DOM extraction and network APIs remain security-sensitive and require manual review. Report unsafe URL handling, message/storage trust-boundary issues, unexpected data transmission, or destructive repository writes privately.
