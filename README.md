# remote-console-web

自宅Ubuntu機上のシミュレーション(AWSIM等)を、ブラウザから遠隔監視・操作するWebアプリ。ターミナル操作とシミュレーションウィンドウの映像確認を1ページで行う。

## 動作前提条件

- ディスプレイサーバーがXorg(X11)であること(`echo $XDG_SESSION_TYPE` が `x11`)。Waylandは非対応。
- 対象ユーザーで自動ログインを有効化し、画面の自動ロック・ブランク・自動サスペンドを無効化しておくこと。
- 依存パッケージ: `sudo apt install -y ffmpeg wmctrl tmux`

## リポジトリ構成

npm workspacesによるモノレポ構成(`server` / `client` / `shared`)。`shared/`はWebSocketプロトコルの型・定数(`shared/protocol.ts`)をclient/server間で共有するための小さなパッケージで、直接編集することはあっても単体で動かすものではない。

## セットアップ

依存関係のインストールは**リポジトリ直下で1回だけ**行う(workspacesが`server`/`client`/`shared`をまとめて解決する)。

```bash
npm install
```

`.env.example` を `.env` にコピーし、値を設定する。

```bash
cp .env.example .env
```

`LOGIN_PASSWORD_HASH` はbcryptハッシュ値(`$2b$10$...`)のため、シェルで直接値を設定する場合はダブルクォートではなく**シングルクォート**を使うこと(`$`がシェル変数展開されるのを防ぐため)。

ビルドは各パッケージ内で行う。`server`・`client`とも自身の`build`/`dev`スクリプトが`shared`のビルドを自動的に先行実行するため、`shared`側で個別にビルドコマンドを打つ必要はない。

```bash
cd server && npm run build
cd ../client && npm run build
```

## 開発

```bash
cd server && npm run dev
cd client && npm run dev
```

`shared/protocol.ts`を編集した場合、`client`はソースを直接参照するため即座に反映されるが、`server`はビルド済みの`shared/dist/`を参照するため、`server`の`dev`/`build`を再実行(または`cd shared && npm run build`)して初めて変更が反映される。
