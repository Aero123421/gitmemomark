# 同梱ライブラリ

Chrome 拡張（MV3）は外部スクリプトを読み込めないため、以下を同梱しています。

Readability の著作権表記は [LICENSE.readability.md](LICENSE.readability.md)、Apache-2.0 の全文は [LICENSE.apache-2.0.txt](LICENSE.apache-2.0.txt)（[取得元](https://www.apache.org/licenses/LICENSE-2.0.txt)）を参照してください。
Turndown には GitMemoMark の変更を加えています: 多数の兄弟ノードで変換結果全体を繰り返し結合せず、配列に蓄積して線形時間で結合します。ライセンスは同梱の LICENSE.turndown / LICENSE.turndown-plugin-gfm に保持しています。

| ファイル | ライブラリ | バージョン | ライセンス |
| --- | --- | --- | --- |
| Readability.js | [@mozilla/readability](https://github.com/mozilla/readability) | 0.6.0 | Apache-2.0 |
| turndown.js | [turndown](https://github.com/mixmark-io/turndown)（browser UMD） | 7.2.4 | MIT |
| turndown-plugin-gfm.js | [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) | 1.0.2 | MIT |
