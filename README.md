# remote-console-web

自宅Ubuntu機上のシミュレーション(AWSIM等)を、ブラウザから遠隔監視・操作するWebアプリ。ターミナル操作とシミュレーションウィンドウの映像確認を1ページで行う。

## 動作前提条件

- ディスプレイサーバーがXorg(X11)であること(`echo $XDG_SESSION_TYPE` が `x11`)。Waylandは非対応。
- 対象ユーザーで自動ログインを有効化し、画面の自動ロック・ブランク・自動サスペンドを無効化しておくこと。
- 依存パッケージ: `sudo apt install -y ffmpeg wmctrl tmux`

## セットアップ

```bash
cd server && npm install && npm run build
cd ../client && npm install && npm run build
```

`.env.example` を `.env` にコピーし、値を設定する。

```bash
cp .env.example .env
```

`LOGIN_PASSWORD_HASH` はbcryptハッシュ値(`$2b$10$...`)のため、シェルで直接値を設定する場合はダブルクォートではなく**シングルクォート**を使うこと(`$`がシェル変数展開されるのを防ぐため)。

## 開発

```bash
cd server && npm run dev
cd client && npm run dev
```
