# macOS デプロイ手順(launchd + Tailscale Serve)

Linuxのsystemd + Tailscale Serve構成(`remote-console-web.service` / `tailscale-serve-setup.md`)のmacOS版。常時起動のMac(自動ログイン済み)上で、launchd LaunchAgentとしてサーバーを自動起動・自動再起動する。

## 前提

- 依存パッケージ: `brew install tmux`(ffmpeg・wmctrl・xdotoolは不要。ウィンドウ一覧・キャプチャ・スリープ防止はすべてmacOS標準コマンドで行う)
- 対象ユーザーで自動ログインを有効化しておくこと(システム設定 → ユーザとグループ → 自動ログイン)。
- スリープ防止はアプリ内の「スリープ防止」トグル(caffeinate)でも行えるが、常用するなら システム設定 → ディスプレイ → 詳細設定 で「ディスプレイがオフのときに自動でスリープさせない」を有効にしておくのが確実。
- `server`・`client`をビルド済みであること(`npm run build`、ルートREADME参照)。

## 画面収録(Screen Recording)権限

ウィンドウのキャプチャ(`screencapture -l`)とウィンドウタイトルの取得には、**nodeを実行するプロセスへの画面収録権限**が必要。権限が無い場合:

- ウィンドウ一覧にアプリ名しか表示されない(ウィンドウタイトルが取れない)
- 映像配信が「配信プロセスが終了しました」で失敗する(`could not create image from window`)

付与手順:

1. まず一度、TerminalなどからサーバーをGUIセッション内で起動し、ウィンドウ配信を試す。初回に画面収録の許可ダイアログが出るので許可する(この場合、権限はTerminal等の起動元アプリに付く)。
2. launchd経由(起動元がTerminalでない)で運用する場合は、システム設定 → プライバシーとセキュリティ → 画面収録とシステムオーディオ録音 で `+` からnodeの実体(例: `/Users/sol/.nodebrew/current/bin/node`、Finderで `Cmd+Shift+G` によりパス指定)を追加する。
3. 権限変更後はサービスの再起動が必要(下記 `kickstart -k`)。

## LaunchAgentの導入

`deploy/com.remote-console-web.plist` はnodeの実パス・リポジトリパスをこの開発機の実測値で埋めてある。**別の機体に導入する場合は `which node` とcloneした場所を確認し、plistを書き換えてから導入すること。**

```bash
cp deploy/com.remote-console-web.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.remote-console-web.plist
```

sudoは不要(ユーザー単位のLaunchAgentのため)。`RunAtLoad` + `KeepAlive` により、ログイン時の自動起動と異常終了時の自動再起動(3秒間隔)が行われる。

状態確認・ログ・操作:

```bash
launchctl print gui/$(id -u)/com.remote-console-web   # 状態確認
tail -f /tmp/remote-console-web.log                    # 標準出力ログ
tail -f /tmp/remote-console-web.err.log                # エラーログ
launchctl kickstart -k gui/$(id -u)/com.remote-console-web   # 再起動(.env変更後など)
launchctl bootout gui/$(id -u)/com.remote-console-web        # 停止・解除
```

`.env`はサーバー自身がdotenvで読むため、launchd側の設定は不要。`.env`を書き換えた場合は`kickstart -k`で再起動する。ポートはplistの`EnvironmentVariables`で`PORT=8444`に上書きしており、開発用(`npm run dev`の8443)と衝突しない(dotenvは既存の環境変数を上書きしないため、plist側の値が勝つ)。

## Tailscale Serve

Linux版と同一(`deploy/tailscale-serve-setup.md`参照)。macOSでは**App Store版ではなくスタンドアロン版(`brew install tailscale`等)のTailscaleが必要**な点に注意(App Store版のサンドボックスではCLIの`serve`が使えない・localhostへの転送に制約がある)。

```bash
tailscale serve --bg --set-path=/remote-console 8444
```
