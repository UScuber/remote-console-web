# client

自宅シミュレーション機を遠隔監視・操作するためのフロントエンド(React + TypeScript + Vite)。

## セットアップ

```bash
npm install
npm run build
```

## スクリプト

- `npm run dev`: Vite開発サーバーを起動
- `npm run build`: `tsc -b && vite build` でビルド(`dist/`に出力)
- `npm run lint`: Oxlintで静的解析
- `npm run preview`: ビルド済み成果物をプレビュー

## WebSocket接続の実装メモ

### `reconnectingWs.ts`

ターミナル・ウィンドウ一覧・映像の全WebSocket共通の自動再接続ヘルパー(Step 7)。切断後は1秒〜30秒の指数バックオフで再接続し、ページ復帰時は即再接続する。

`CONNECT_TIMEOUT_MS`: iOS Safari(WebKit)では、ハンドシェイク中(CONNECTING)のソケットを中断した直後に同一ホストへ新しいハンドシェイクを張ると、open/error/closeのいずれも発火せず固まることが実機で確認された。closeが来ないと再接続経路に乗らないため、このタイムアウトで強制的にclose扱いへ変換している。

`STABLE_CONNECTION_MS`: 接続直後に即切断が続くケース(サーバー側の問題等)でバックオフが短いまま高頻度リトライし続けないよう、これ以上接続を維持できていたら「安定していた」とみなし次回切断時のバックオフを初期値に戻す。open直後ではなくclose時に判定する。

`FORCE_RECONNECT_HIDDEN_MS`: ページがこれ以上hidden状態だった場合、visible復帰時に見かけ上OPENの接続でも強制的に張り直して生存確認する。iOSの長時間サスペンド中に回線が切れてもFINが届かず、復帰後もreadyStateがOPENのまま残る「ゾンビ接続」への対策。

### `sharedWs.ts`

`reconnectingWs.ts`をURLごとに1本だけ共有する参照カウント方式のラッパー。

React 18のStrictMode(開発時のみ)は各エフェクトを同一tick内で「セットアップ→クリーンアップ→セットアップ」と二重実行する。各コンポーネントが`createReconnectingWs`を直接エフェクト内で生成・破棄すると、CONNECTING中のソケットを閉じた直後に同じURLへ張り直すことになり、上記のiOS Safariハンドシェイク固着を踏みやすい。Reactは意図的に「検証用の二重実行か本当の再マウントか」を区別する手段を提供していないため、接続の実体をエフェクトのライフサイクルから切り離し参照カウントで共有する(Reactが推奨する定石)ことで回避している。

- 購読者ゼロになった直後はマイクロタスク(`Promise.resolve().then`)で再確認してから実際に閉じる。StrictModeの登録→解除→登録が同一tickで起きるケースでは、この再確認より前に次の登録が来るため実体のWebSocketには触れない。
- 接続の乗り換え(既存接続に新しい購読者が付く場合)では、直近のイベント種別(`LastEvent`)を新しい購読者に同期的に再生し、状態の取りこぼしを防ぐ。

## その他の実装メモ

### `components/TerminalPanel.tsx`

- 公式のws直結アドオン(`@xterm/addon-attach`)は使わず、`onData`/`onResize`を自前で配線している。このアプリはinput/resizeを1本のWebSocketにJSONフレームで多重化しており、addon-attachは生バイト列の送受信のみでresizeを運べないため。
- マウス/タッチ座標のレポートは、pty側(tmux)がマウストラッキングを要求した時点でxterm.jsが自動的に開始する(`server/tmux.conf`の`set -g mouse on`と対になる設定で、JS側で別途有効化する設定は不要)。
- `fitAddon.fit()`はterm.resize()を経由して再描画するため、iOS SafariのIME変換中に呼ぶと確定前の文字が消えることがある。ソフトウェアキーボードの出現自体もリサイズを起こすため、変換中はリサイズを保留しcompositionend後に適用している。

### `components/terminalTouchScroll.ts`

履歴はtmuxのcopy-mode側にあり、xtermはタッチイベントをスクロールに配線しないため、縦ドラッグをxtermと同じ経路(合成WheelEvent)に載せ替えてcopy-modeをスクロールさせている。1ノッチ=1行にする設定は`server/tmux.conf`側にあり、指の移動量に比例した数のホイールイベントを送ることで指に追従させる。

### `components/TerminalReviewSheet.tsx`

xterm(canvas描画)+tmux(mouse on)構成では、モバイルでの文字選択・コピーがどのライブラリでも自動では得られない(PCはShift+ドラッグでxterm選択をバイパスできるが、iPhoneソフトキーボードにShift相当が無い)。別サーフェス案(tmuxのスクロールバックを色付きHTMLとしてDOMに描画し、iOSネイティブの長押し選択・コピーに任せる)を採用した。検討した他案との比較は`CLAUDE.md`のStep 4追加実装を参照。

### `components/WindowStream.tsx`

`END_REASON_LABEL`のキーは`server/src/stream/ffmpegStream.ts`の`CLOSE_CODES`と文字列一致させる必要がある。サーバー側にreasonを追加・変更したら両方直すこと。
