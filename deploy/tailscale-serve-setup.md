# Tailscale Serve 設定手順

このアプリ(`server`)は本番(systemd)実行時 `127.0.0.1:8444` でHTTPのみをlistenする(Step 2で確定済み。開発時の`npm run dev`は`.env`のPORT=8443のまま使うため、systemdユニット側だけ`Environment=PORT=8444`で上書きして両立させている)。TailnetからのHTTPS化とTLS証明書はTailscale Serveに任せる。

## 前提

- `tailscaled` が起動済み・ログイン済みであること(このマシンでは確認済み: `tailscale status` で `sota` として表示される)。
- MagicDNSが有効であること(このtailnetでは有効: `sota.tail7d691c.ts.net` でこのマシンに到達できる)。

## Serveの設定

```bash
sudo tailscale serve --bg --set-path=/remote-console 8444
```

- 使用しているTailscale CLI(v1.98系)では `tailscale serve <target>` の位置引数がローカルの転送先を表し、公開側のプロトコル/ポートは `--https`(既定443)で決まる。`--set-path=/remote-console`により、このアプリは`/`ではなく`/remote-console`配下にマウントされる(同一マシンから将来他のアプリも配信する場合にパスが衝突しないようにするため)。上記コマンドは「Tailnet内から `https://<このマシン>.tail7d691c.ts.net/remote-console`(443番)へのアクセスを、ローカルの `http://127.0.0.1:8444` へ転送する」設定になる。旧バージョンの `tailscale serve https / http://localhost:8443` 形式のコマンドはこのバージョンでは受け付けられないため注意。
- `--bg` を付けることで、`tailscale serve` コマンド自体を終了してもバックグラウンドで設定が有効なままになる(付けないとフォアグラウンドで動き続け、コマンドを終了すると公開も止まる)。
- 設定内容の確認: `tailscale serve status`
- 設定の解除: `tailscale serve reset`
- **重要(パスの扱いの整理)**: Tailscale Serveは`--set-path`で指定したプレフィックスを**剥がしてから**バックエンドへ転送する(実機で確認済み)。この結果、対応が必要な範囲はサーバー側とクライアント側で非対称になる。
  - **サーバー(Express)側は変更不要**: 届くリクエストは常に`/api/...`・`/ws/...`・`/assets/...`のようにプレフィックス無しなので、`server/src/index.ts`は`/`基準のまま。
  - **クライアント側は対応が必要**: ブラウザは「表示中のページのURL」を基準にリクエストを発行するため、アセット参照・fetch・WebSocketのURLはプレフィックス付き(`/remote-console/api/...`等)で発行しなければ、Tailscale Serveのマウントに一致せず404になる。このため`client/vite.config.ts`に`base: "/remote-console/"`を設定し、fetch・WebSocketのURLは`import.meta.env.BASE_URL`経由でこの値を反映している。開発時(`npm run dev`)はviteのproxyが`rewrite`で同じようにプレフィックスを剥がしてバックエンド(8443)へ渡すため、開発・本番で同じURL構造になる。

設定後、iPhoneのSafariから `https://sota.tail7d691c.ts.net/remote-console/` にアクセスするとログイン画面が表示される想定(証明書はTailscaleが自動発行するため、ブラウザ上の警告は出ない)。ルート `https://sota.tail7d691c.ts.net/`(プレフィックス無し)には何もマウントされていないため404になる。

### 証明書について

Tailscale ServeはTailnet用に自動発行されたTLS証明書を使う。証明書がまだ発行されていない場合、`tailscale serve --bg --set-path=/remote-console 8444` の初回実行時に自動取得されるが、管理画面でHTTPS証明書の発行が有効化されている必要がある(Tailscale管理画面 → **DNS** タブ → **HTTPS Certificates** が有効になっていることを確認する)。
