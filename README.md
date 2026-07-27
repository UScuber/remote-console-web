# remote-console-web

自宅マシン上のシミュレーション(AWSIM等)やアプリを、ブラウザから遠隔監視・操作するWebアプリ。ターミナル操作とウィンドウの映像確認を1ページで行う。Linux(Ubuntu/X11)とmacOSに対応。

## 動作前提条件

### Linux (Ubuntu)

- ディスプレイサーバーがXorg(X11)であること(`echo $XDG_SESSION_TYPE` が `x11`)。Waylandは非対応。
- 対象ユーザーで自動ログインを有効化し、画面の自動ロック・ブランク・自動サスペンドを無効化しておくこと。
- 依存パッケージ: `sudo apt install -y ffmpeg wmctrl tmux xdotool`

### macOS

- 依存パッケージ: `brew install tmux` のみ(ffmpeg・wmctrl・xdotoolは不要。ウィンドウ一覧・映像キャプチャ・スリープ防止はすべてmacOS標準の`osascript`/`screencapture`/`sips`/`caffeinate`で行う)。
- **画面収録(Screen Recording)権限**: ウィンドウタイトルの取得と映像キャプチャには、nodeを実行するプロセス(開発時はTerminal等、launchd運用時はnode本体)への画面収録権限が必要。付与手順は`deploy/macos-launchd-setup.md`を参照。
- 映像は`screencapture`の定期実行方式のため約2fps(Linuxのffmpeg 15fpsより低いが、状態監視用途には十分)。
- 常時運用する場合は自動ログインを有効化し、システム設定でスリープを無効化しておくこと(アプリ内の「スリープ防止」トグルでも`caffeinate`による抑止が可能)。

## リポジトリ構成

npm workspacesによるモノレポ構成(`server` / `client` / `shared`)。`shared/`はWebSocketプロトコルの型・定数(`shared/protocol.ts`)をclient/server間で共有するための小さなパッケージで、直接編集することはあっても単体で動かすものではない。

## セットアップ

依存関係のインストールは**リポジトリ直下で1回だけ**行う(workspacesが`server`/`client`/`shared`をまとめて解決する)。

```bash
npm install
```

npmの展開時にnode-ptyのprebuiltヘルパー(`spawn-helper`)の実行権限が失われ、ターミナル起動が`posix_spawnp failed`で失敗することがある(macOSで実際に発生)。ルート`package.json`の`postinstall`で自動修復されるため通常は意識不要だが、既存の`node_modules`で同エラーが出る場合は`npm install`を再実行すること。

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

## デプロイ(systemd/launchd + Tailscale Serve)

**macOSの場合はlaunchdを使う。手順は`deploy/macos-launchd-setup.md`を参照(以下のsystemd手順のmacOS版)。**

Linuxでの本番運用時は、常時起動機(自動ログイン済みのUbuntu Desktop)上で以下の3つを組み合わせる。

1. `server`・`client`をそれぞれビルドしておく(`npm run build`、上記参照)。サーバーは`client/dist`を静的配信する。
2. systemdサービスとして`server`を自動起動・自動再起動する(`deploy/remote-console-web.service`)。
3. Tailscale Serveでこのアプリ(ローカル`127.0.0.1:8444`、systemdユニット側で開発用の8443と衝突しないよう上書き)を`/remote-console`パス配下でTailnet内にHTTPS公開する(同一マシンから将来他のアプリも配信する場合にパスが衝突しないようにするため。`deploy/tailscale-serve-setup.md`)。

### systemdサービスの導入

`deploy/remote-console-web.service`はUser・DISPLAY・Xauthority・リポジトリパス・nodeの実パスをこの開発機の実測値で埋めてある。**別の機体に導入する場合は下記を実機で確認し、ユニットファイルを書き換えてから導入すること。**

- `echo $DISPLAY`(自動ログインしたグラフィカルセッション内で実行。`:0`以外の場合がある)
- `which node`(nvm等でNodeを管理している場合、`/usr/bin/node`ではない実パスになっていることが多い)
- リポジトリの実際のclone先パス

```bash
sudo cp deploy/remote-console-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now remote-console-web.service
```

状態確認・ログ:

```bash
systemctl status remote-console-web.service
journalctl -u remote-console-web.service -f
```

このサービスは`EnvironmentFile`でリポジトリ直下の`.env`を読み込む。`.env`を書き換えた場合は`sudo systemctl restart remote-console-web.service`が必要。

サービスは`graphical.target`(自動ログインのグラフィカルセッション)到達後に起動を試みるが、X11セッションの起動タイミングによっては初回起動時にDISPLAYへ接続できず失敗することがある。`Restart=always`・`RestartSec=3`により自動的に再試行されるため、通常は数秒後に正常起動する。

### Tailscale Serve

手順・ACLでのアクセス制限方法は`deploy/tailscale-serve-setup.md`を参照。
