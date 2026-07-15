# client

自宅シミュレーション機を遠隔監視・操作するためのフロントエンド(React + TypeScript + Vite)。

## セットアップ

依存関係のインストールはリポジトリ直下で(`npm install`、npm workspaces構成のため)。

```bash
npm run build
```

## スクリプト

- `npm run dev`: `shared`を先にビルドしてからVite開発サーバーを起動
- `npm run build`: `shared`を先にビルドしてから`tsc -b && vite build`でビルド(`dist/`に出力)
- `npm run lint`: Oxlintで静的解析
- `npm run preview`: ビルド済み成果物をプレビュー

## `../shared/protocol.ts`との関係

`WindowInfo`型、WebSocketメッセージ形、`WINDOW_STREAM_CLOSE_CODES`等のclient/server間で一致していなければならない型・定数は`shared/protocol.ts`からimportする。clientはビルド済み出力ではなくソース(`.ts`)を直接参照するため、`shared/`を編集しても別途ビルドは不要(Viteがそのまま読み込む)。

## WebSocket接続の実装メモ

### `reconnectingWs.ts`

ターミナル・ウィンドウ一覧・映像の全WebSocket共通の自動再接続ヘルパー(Step 7)。切断後は1秒〜30秒の指数バックオフで再接続し、ページ復帰時は即再接続する。

`CONNECT_TIMEOUT_MS`: iOS Safari(WebKit)では、ハンドシェイク中(CONNECTING)のソケットを中断した直後に同一ホストへ新しいハンドシェイクを張ると、open/error/closeのいずれも発火せず固まることが実機で確認された。closeが来ないと再接続経路に乗らないため、このタイムアウトで強制的にclose扱いへ変換している。

`STABLE_CONNECTION_MS`: 接続直後に即切断が続くケース(サーバー側の問題等)でバックオフが短いまま高頻度リトライし続けないよう、これ以上接続を維持できていたら「安定していた」とみなし次回切断時のバックオフを初期値に戻す。open直後ではなくclose時に判定する。

`FORCE_RECONNECT_HIDDEN_MS`: ページがこれ以上hidden状態だった場合、visible復帰時に見かけ上OPENの接続でも強制的に張り直して生存確認する。iOSの長時間サスペンド中に回線が切れてもFINが届かず、復帰後もreadyStateがOPENのまま残る「ゾンビ接続」への対策。

### `sharedWs.ts`

`reconnectingWs.ts`をURLごとに1本だけ共有する参照カウント方式のラッパー。**同一URLへの「現在の購読者」は常に1人だけを想定している**(2つの別コンポーネントが同じURLを同時に購読した場合、後から呼んだ側が無条件に主導権を奪う。StrictModeの二重実行や同一コンポーネントの再マウントでの再購読は想定内だが、異なる2箇所からの同時購読は想定外)。所有権の判定は購読ごとに発行する専用の`Symbol`(トークン)で行い、オプションオブジェクトの参照同一性には頼らない。

React 18のStrictMode(開発時のみ)は各エフェクトを同一tick内で「セットアップ→クリーンアップ→セットアップ」と二重実行する。各コンポーネントが`createReconnectingWs`を直接エフェクト内で生成・破棄すると、CONNECTING中のソケットを閉じた直後に同じURLへ張り直すことになり、上記のiOS Safariハンドシェイク固着を踏みやすい。Reactは意図的に「検証用の二重実行か本当の再マウントか」を区別する手段を提供していないため、接続の実体をエフェクトのライフサイクルから切り離し参照カウントで共有する(Reactが推奨する定石)ことで回避している。

- 購読者ゼロになった直後はマイクロタスク(`Promise.resolve().then`)で再確認してから実際に閉じる。StrictModeの登録→解除→登録が同一tickで起きるケースでは、この再確認より前に次の登録が来るため実体のWebSocketには触れない。
- 接続の乗り換え(既存接続に新しい購読者が付く場合)では、直近のイベント種別(`LastEvent`)を新しい購読者に同期的に再生し、状態の取りこぼしを防ぐ。

### `wsUrl.ts` / `connectionLabels.ts`

`TerminalPanel`(`useTerminalWs`)・`useWindowList`・`WindowStream`の3箇所で重複していたプロトコル判定+URL組み立て(`wsUrl`)と、接続状態の日本語ラベル(`CONN_STATUS_LABEL`)を集約したもの。各コンポーネント固有の状態(`superseded`・`streaming`・`ended`等)はこれを展開した上で追加する。

## その他の実装メモ

### `components/TerminalPanel.tsx` とその関連hook

xterm自体のライフサイクル(`useXtermTerminal.ts`)とWebSocket配線(`useTerminalWs.ts`)をhookとして分離し、`TerminalPanel.tsx`はその2つとCtrl修飾トグル・入力欄・特殊キーバー(`TerminalKeyBar.tsx`)といったUI固有の状態だけを持つ。

- `useXtermTerminal.ts`: xterm.jsインスタンス・`FitAddon`・`WebLinksAddon`の生成、タッチスクロール配線、IME変換中のリサイズ保留を担当する。`fitAddon.fit()`はterm.resize()を経由して再描画するため、iOS SafariのIME変換中に呼ぶと確定前の文字が消えることがある。ソフトウェアキーボードの出現自体もリサイズを起こすため、変換中はリサイズを保留しcompositionend後に適用している。
- `useTerminalWs.ts`: `/ws/terminal`への接続・再接続・状態管理、および`term.onResize`→`resize`メッセージ送信、受信データの`term.write()`を配線する。`term.onData`(入力)だけはCtrl修飾トグルというUI固有の変換を挟むため、こちらではなく`TerminalPanel.tsx`側で配線する。
- 公式のws直結アドオン(`@xterm/addon-attach`)は使わず、input/resizeを1本のWebSocketにJSONフレームで多重化する自前配線にしている。addon-attachは生バイト列の送受信のみでresizeを運べないため。
- マウス/タッチ座標のレポートは、pty側(tmux)がマウストラッキングを要求した時点でxterm.jsが自動的に開始する(`server/tmux.conf`の`set -g mouse on`と対になる設定で、JS側で別途有効化する設定は不要)。

### `components/terminalTouchScroll.ts`

履歴はtmuxのcopy-mode側にあり、xtermはタッチイベントをスクロールに配線しないため、縦ドラッグをxtermと同じ経路(合成WheelEvent)に載せ替えてcopy-modeをスクロールさせている。1ノッチ=1行にする設定は`server/tmux.conf`側にあり、指の移動量に比例した数のホイールイベントを送ることで指に追従させる。

### `components/TerminalReviewSheet.tsx`

xterm(canvas描画)+tmux(mouse on)構成では、モバイルでの文字選択・コピーがどのライブラリでも自動では得られない(PCはShift+ドラッグでxterm選択をバイパスできるが、iPhoneソフトキーボードにShift相当が無い)。別サーフェス案(tmuxのスクロールバックを色付きHTMLとしてDOMに描画し、iOSネイティブの長押し選択・コピーに任せる)を採用した。検討した他案との比較は`CLAUDE.md`のStep 4追加実装を参照。

### `useWindowList.ts` / `components/WindowPicker.tsx`

`/ws/windows`の購読は`useWindowList.ts`(App側で利用)に一本化しており、`WindowPicker.tsx`は`windows`・`status`等をpropsで受け取るだけの表示専用コンポーネント。以前はWindowPickerが購読しApp側へ`onWindowsChange`で一覧を吸い上げる子→親のサイドチャネルだったが、一覧の所有者をApp(`useWindowList`)側に一本化した。

### `components/WindowStream.tsx`

`END_REASON_LABEL`のキーの型は`shared/protocol.ts`の`WindowStreamEndReason`(+ クライアントローカルな`"not_listed"`)。サーバー側の`shared/protocol.ts`にreasonを追加すればここが型エラーになるため、以前のような文字列一致をコメントで揃えるだけの運用ではなくなっている。`status`のstate/ref二重管理は`transition()`関数に集約し、片方だけ更新し忘れるミスを防いでいる。
