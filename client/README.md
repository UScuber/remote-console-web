# client

自宅シミュレーション機を遠隔監視・操作するためのフロントエンド(React + TypeScript + Vite)。

## セットアップ

```bash
npm install
npm run build
```

## スクリプト

- `npm run dev`: Vite開発サーバーを起動
- `npm run build`: `tsc -b && vite build` でビルド(`dist/`に出力)
- `npm run lint`: Oxlintで静的解析
- `npm run preview`: ビルド済み成果物をプレビュー

## WebSocket接続の実装メモ

### `reconnectingWs.ts`
ターミナル・ウィンドウ一覧・映像の全WebSocket共通の自動再接続ヘルパー(Step 7)。切断後は1秒〜30秒の指数バックオフで再接続し、ページ復帰時は即再接続する。

`CONNECT_TIMEOUT_MS`: iOS Safari(WebKit)では、ハンドシェイク中(CONNECTING)のソケットを中断した直後に同一ホストへ新しいハンドシェイクを張ると、open/error/closeのいずれも発火せず固まることが実機で確認された。closeが来ないと再接続経路に乗らないため、このタイムアウトで強制的にclose扱いへ変換している。

### `sharedWs.ts`
`reconnectingWs.ts`をURLごとに1本だけ共有する参照カウント方式のラッパー。

React 18のStrictMode(開発時のみ)は各エフェクトを同一tick内で「セットアップ→クリーンアップ→セットアップ」と二重実行する。各コンポーネントが`createReconnectingWs`を直接エフェクト内で生成・破棄すると、CONNECTING中のソケットを閉じた直後に同じURLへ張り直すことになり、上記のiOS Safariハンドシェイク固着を踏みやすい。Reactは意図的に「検証用の二重実行か本当の再マウントか」を区別する手段を提供していないため、接続の実体をエフェクトのライフサイクルから切り離し参照カウントで共有する(Reactが推奨する定石)ことで回避している。

- 購読者ゼロになった直後はマイクロタスク(`Promise.resolve().then`)で再確認してから実際に閉じる。StrictModeの登録→解除→登録が同一tickで起きるケースでは、この再確認より前に次の登録が来るため実体のWebSocketには触れない。
- 接続の乗り換え(既存接続に新しい購読者が付く場合)では、直近のイベント種別(`LastEvent`)を新しい購読者に同期的に再生し、状態の取りこぼしを防ぐ。
