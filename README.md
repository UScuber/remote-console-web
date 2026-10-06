# remote-console-web

Ubuntu機のシミュレーションをブラウザから監視・操作するアプリです。

## セットアップ

Xorg（X11）のUbuntu Desktopで、自動ログインを有効にし、画面ロック・画面消灯・自動サスペンドを無効にします。

```bash
sudo apt install -y ffmpeg wmctrl tmux
npm install
cp .env.example .env
```

`.env`を編集し、`LOGIN_PASSWORD_HASH`にはbcryptハッシュを設定してください。

## 開発

別々のターミナルで実行します。

```bash
npm run dev -w server
npm run dev -w client
```

## ビルド

```bash
npm run build -w server
npm run build -w client
```

## デプロイ

`deploy/remote-console-web.service`のユーザー名、リポジトリパス、`DISPLAY`、`XAUTHORITY`、Nodeのパスを実機に合わせて変更します。

```bash
sudo cp deploy/remote-console-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now remote-console-web.service
```

Tailscale Serveの設定は[デプロイ手順](deploy/tailscale-serve-setup.md)を参照してください。
