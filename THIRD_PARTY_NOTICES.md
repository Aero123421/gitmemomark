# Third-party notices

GitMemoMark's original code and documentation use [Apache-2.0](LICENSE). Vendored components retain their own licenses and copyright notices; the project license does not relicense them. Preserve the files below when redistributing this extension.

| Component | Bundled version | License / retained notice | Source |
| --- | --- | --- | --- |
| Mozilla Readability | 0.6.0 | [Apache-2.0](src/vendor/LICENSE.apache-2.0.txt); [copyright notice](src/vendor/LICENSE.readability.md) | [mozilla/readability](https://github.com/mozilla/readability) |
| Turndown (browser UMD) | 7.2.4 | [MIT, full text](src/vendor/LICENSE.turndown) | [mixmark-io/turndown](https://github.com/mixmark-io/turndown) |
| turndown-plugin-gfm | 1.0.2 | [MIT, full text](src/vendor/LICENSE.turndown-plugin-gfm) | [mixmark-io/turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) |

## Readability attribution

Copyright (c) 2010 Arc90 Inc. Licensed under the Apache License, Version 2.0. The complete existing Apache license text is retained both in [the vendor directory](src/vendor/LICENSE.apache-2.0.txt) and [the root license](LICENSE). See also the source header in [Readability.js](src/vendor/Readability.js).

## Turndown and GFM attribution

Both bundled MIT notices state: Copyright (c) 2017 Dom Christie. The full permission grant and warranty disclaimer remain in [LICENSE.turndown](src/vendor/LICENSE.turndown) and [LICENSE.turndown-plugin-gfm](src/vendor/LICENSE.turndown-plugin-gfm), not just an SPDX identifier.

**Modified component disclosure:** GitMemoMark changes [turndown.js](src/vendor/turndown.js) so conversion across many sibling nodes accumulates results in an array and joins in linear time, rather than repeatedly concatenating the entire output. This is not an unmodified upstream build. The existing [vendor README](src/vendor/README.md) also records this change.

## Saved content and names

Web pages, X posts, linked images, and other saved third-party content are not covered by GitMemoMark's license. Users must obtain any necessary permissions. GitHub, Chrome, X, and TypeSafe/Jev names identify integrations only; no endorsement or trademark permission is implied.
