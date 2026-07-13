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

- `GET /`: 未認証ならログインページ、認証済みならメイン画面(プレースホルダー)。CSRFトークンを`<meta name="csrf-token">`で埋め込む
- `POST /api/login`: `{ "password": "..." }` をbcrypt比較。成功でセッションCookie発行。5回連続失敗で60秒ロック
- `POST /api/logout`: セッション失効
- `WS /ws/terminal`: tmux経由のターミナル入出力。接続時にセッションCookieを検証。有効な接続は1つのみで、新規接続は既存接続を`close(4000, "superseded")`で置き換える

セッション管理は`express-session`(+`memorystore`)、CSRF対策は`csrf-sync`(Synchronizer Token Pattern、トークンはセッションに保持)を利用。`POST /api/login`・`POST /api/logout`は要求ヘッダー`X-CSRF-Token`がセッション内のトークンと一致する必要がある。
