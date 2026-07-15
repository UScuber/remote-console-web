# server

自宅シミュレーション機を遠隔監視・操作するためのバックエンド(Express + Node.js + TypeScript)。

## セットアップ

```bash
npm install
npm run build
```

環境変数はリポジトリルートの `.env.example` を参照(`../.env` に配置)。

## スクリプト

- `npm run dev`: `tsx watch` で開発起動
- `npm run build`: `tsc` でビルド(`dist/`に出力)
- `npm run start`: ビルド済みの `dist/index.js` を起動

## 現在実装済みのエンドポイント

- `GET /api/session`: 認証状態・CSRFトークン・`MAX_ACTIVE_STREAMS`を返す。クライアントはこれで描画を分岐する
- `GET /api/terminal/history`: tmuxのスクロールバックを返す(「テキスト表示」用、参照のみなのでCSRF保護は無し)
- `POST /api/login`: `{ "password": "..." }` をbcrypt比較。成功でセッションCookie発行。5回連続失敗で60秒ロック
- `POST /api/logout`: セッション失効
- `WS /ws/terminal`: tmux経由のターミナル入出力。有効な接続は1つのみで、新規接続は既存接続を`close(4000, "superseded")`で置き換える
- `WS /ws/windows`: 起動中ウィンドウ一覧(id・タイトル)の配信
- `WS /ws/window/:id`: 指定windowIdの映像(MJPEG)配信。同一idへの接続は後勝ち

全WebSocketは接続時にセッションCookieを検証し、`MAX_ACTIVE_STREAMS`(既定3)まで同時映像配信を許可する。

セッション管理は`express-session`(+`memorystore`)、CSRF対策は`csrf-sync`(Synchronizer Token Pattern、トークンはセッションに保持)を利用。`POST /api/login`・`POST /api/logout`は要求ヘッダー`X-CSRF-Token`がセッション内のトークンと一致する必要がある。

## 実装メモ

### 認証・セッション(`auth/`)

- WebSocketアップグレード要求は`express`の`Response`を持たず`sessionMiddleware`をそのまま通せないため、`middleware.ts`の`isRequestAuthenticated`でCookie署名検証とセッションストア照会を個別に実装している。
- ログイン失敗のロックアウトはIPごとではなくグローバルカウンタ(5回失敗で60秒ロック)。Tailscale Serve経由では接続元IPが常に`127.0.0.1`に見えるため、IP単位のカウントは機能しない(利用者1人の前提で実害はない)。

### ターミナル(`terminal/ptyManager.ts`)

- `tmux new-session -A -s $TMUX_SESSION_NAME`をnode-pty経由で起動する。有効な接続は常に1つのみで、新規接続は既存接続を`close(4000, "superseded")`で置き換える。tmuxセッション自体は共有なので置き換えても作業画面は失われない。

### ウィンドウ一覧(`stream/windowDetector.ts`)

- `wmctrl -l`を2秒間隔でポーリングする。出力は`id desktop host title...`の空白区切りだがtitleに空白を含みうるため、先頭3列だけを分割している。
- `WINDOW_TITLE_EXCLUDE`(カンマ区切り)で、このWebアプリ自身のブラウザウィンドウ等をタイトルの部分一致で除外できる。

### 映像配信(`stream/ffmpegStream.ts`)

- ffmpegのstdoutはフレーム境界の通知が無い連続バイト列のため、JPEGのSOI(`0xFFD8`)〜EOI(`0xFFD9`)マーカーで自前に1フレームずつ切り出している。
- 非アクティブ(帯域節約モード)なストリームは`STATIC_STREAM_INTERVAL_MS`ごとにしか送信しない。クライアント側で受信後に間引いても帯域は減らないため、送信元であるここで間引く。
- `ws.bufferedAmount`が閾値を超えているフレームは古い順ではなく丸ごと破棄し、常に最新映像を優先する。
- 最小化・画面外配置時のx11grab挙動が機種依存で不定なため(検証結果は`CLAUDE.md`のStep 0参照)、最初のフレームが一定時間内に届かない場合は一律タイムアウトで異常とみなす。
- クライアントへの終了理由(`ended`メッセージの`reason`とWebSocket close code)は`CLOSE_CODES`にまとめている。このキー一覧は`client/src/components/WindowStream.tsx`の`END_REASON_LABEL`と文字列一致させる必要があるため、追加・変更時は両方直すこと。

### 死活監視(`wsHeartbeat.ts`)

- `/ws/terminal`・`/ws/windows`・`/ws/window/:id`共通で30秒間隔のpingを送り、pongが2回連続で返らない接続は`terminate()`で切断する。`terminate()`でも`close`イベントは発火するため、各ハンドラ側のリソース解放(ptyのkill・ffmpegのkill等)はそのまま流用される。
