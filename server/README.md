# server

自宅シミュレーション機を遠隔監視・操作するためのバックエンド(Express + Node.js + TypeScript)。

## セットアップ

依存関係のインストールはリポジトリ直下で(`npm install`、npm workspaces構成のため)。

```bash
npm run build
```

環境変数はリポジトリルートの `.env.example` を参照(`../.env` に配置)。必須環境変数の一覧・検証は`src/config.ts`に集約している(未設定・不正値は起動時に例外で気づける)。

## スクリプト

- `npm run dev`: `shared`を先にビルドしてから`tsx watch`で開発起動
- `npm run build`: `shared`を先にビルドしてから`tsc`でビルド(`dist/`に出力)
- `npm run start`: ビルド済みの `dist/index.js` を起動

## 現在実装済みのエンドポイント

- `GET /api/session`: 認証状態・CSRFトークン・`MAX_ACTIVE_STREAMS`を返す。クライアントはこれで描画を分岐する
- `GET /api/terminal/history/:id`: 指定枠(`"1"`〜`"6"`)のtmuxスクロールバックを返す(「テキスト表示」用、参照のみなのでCSRF保護は無し)
- `POST /api/login`: `{ "password": "..." }` をbcrypt比較。成功でセッションCookie発行。5回連続失敗で60秒ロック
- `POST /api/logout`: セッション失効
- `WS /ws/terminal/:id`: tmux経由のターミナル入出力。固定6枠(`shared/protocol.ts`の`TERMINAL_COUNT`)、枠ごとに独立したtmuxセッションを持つ。同一枠への有効な接続は1つのみで、新規接続は既存接続を`close(4000, "superseded")`で置き換える(別の枠には影響しない)
- `WS /ws/windows`: 起動中ウィンドウ一覧(id・タイトル)の配信
- `WS /ws/window/:id`: 指定windowIdの映像(MJPEG)配信。同一idへの接続は後勝ち

全WebSocketは接続時にセッションCookieを検証し、`MAX_ACTIVE_STREAMS`(既定3)まで同時映像配信を許可する。

セッション管理は`express-session`(+`memorystore`)、CSRF対策は`csrf-sync`(Synchronizer Token Pattern、トークンはセッションに保持)を利用。`POST /api/login`・`POST /api/logout`は要求ヘッダー`X-CSRF-Token`がセッション内のトークンと一致する必要がある。

## 実装メモ

### 認証・セッション(`auth/`)

- WebSocketアップグレード要求は`express`の`Response`を持たず`sessionMiddleware`をそのまま通せないため、`middleware.ts`の`isRequestAuthenticated`でCookie署名検証とセッションストア照会を個別に実装している。
- ログイン失敗のロックアウトはIPごとではなくグローバルカウンタ(5回失敗で60秒ロック)。Tailscale Serve経由では接続元IPが常に`127.0.0.1`に見えるため、IP単位のカウントは機能しない(利用者1人の前提で実害はない)。

### ターミナル(`terminal/ptyManager.ts`)

- 固定6枠(id `"1"`〜`"6"`、`shared/protocol.ts`の`TERMINAL_COUNT`)。枠ごとに`tmux new-session -A -s ${TMUX_SESSION_NAME}-<id>`をnode-pty経由で起動し、`activeConnections`は枠idをキーにしたMapで管理する。同一枠内の有効な接続は常に1つのみで、新規接続は同じ枠の既存接続を`close(4000, "superseded")`で置き換える(枠ごとのtmuxセッションは共有なので置き換えても作業画面は失われない。別の枠には影響しない)。

### ウィンドウ一覧(`stream/windowDetector.ts`)

- `wmctrl -l`を2秒間隔でポーリングする。出力は`id desktop host title...`の空白区切りだがtitleに空白を含みうるため、先頭3列だけを分割している。
- `WINDOW_TITLE_EXCLUDE`(カンマ区切り)で、このWebアプリ自身のブラウザウィンドウ等をタイトルの部分一致で除外できる。

### 映像配信(`stream/ffmpegStream.ts`)

- ffmpegのstdoutはフレーム境界の通知が無い連続バイト列のため、JPEGのSOI(`0xFFD8`)〜EOI(`0xFFD9`)マーカーで自前に1フレームずつ切り出している(純関数`extractJpegFrames`に分離、チャンク境界でマーカーが割れるケースは未確定分を`rest`として次のチャンクへ持ち越す)。
- 非アクティブ(帯域節約モード)なストリームは`STATIC_STREAM_INTERVAL_MS`ごとにしか送信しない。クライアント側で受信後に間引いても帯域は減らないため、送信元であるここで間引く。
- `ws.bufferedAmount`が閾値を超えているフレームは古い順ではなく丸ごと破棄し、常に最新映像を優先する。
- 最小化・画面外配置時のx11grab挙動が機種依存で不定なため(検証結果は`CLAUDE.md`のStep 0参照)、最初のフレームが一定時間内に届かない場合は一律タイムアウトで異常とみなす。
- クライアントへの終了理由(`ended`メッセージの`reason`とWebSocket close code)は`shared/protocol.ts`の`WINDOW_STREAM_CLOSE_CODES`/`WindowStreamEndReason`にまとめている。client側の`WindowStream.tsx`もこの型を`import`しているため、reasonを追加した際に片方だけ直し忘れるとコンパイルエラーで検知できる(以前は文字列一致をコメントで揃えるだけだった)。

### プロトコル定義(`../shared/protocol.ts`)

- `WindowInfo`型、`/ws/windows`・`/ws/terminal/:id`・`/ws/window/:id`のメッセージ形、close code表、ターミナル枠数(`TERMINAL_COUNT`/`TERMINAL_IDS`/`isValidTerminalId`)など、client/server間で一致していなければならない型・定数をここに集約している。serverは`npm run build`時にビルドされる`shared/dist/`を、clientは`shared/*.ts`のソースを直接参照する(詳細はリポジトリ直下のREADME参照)。

### 死活監視(`wsHeartbeat.ts`)

- `/ws/terminal/:id`・`/ws/windows`・`/ws/window/:id`共通で30秒間隔のpingを送り、pongが2回連続で返らない接続は`terminate()`で切断する。`terminate()`でも`close`イベントは発火するため、各ハンドラ側のリソース解放(ptyのkill・ffmpegのkill等)はそのまま流用される。

### 終了処理(`index.ts`)

- `SIGTERM`/`SIGINT`受信時に、アクティブなpty(ターミナル)・ffmpeg(映像)の子プロセスを明示的にkillしてからプロセスを終了する(`ptyManager.shutdownTerminal` / `ffmpegStream.shutdownStreams`)。パイプ切断で子プロセスも実質的には終了するはずだが、systemd運用(Step 8)で終了タイミングに依存しないようにするための処理。
