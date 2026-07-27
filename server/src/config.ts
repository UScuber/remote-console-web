// このアプリが必要とする環境変数の完全な一覧と検証をここに集約する。
// 各モジュールはprocess.envを直接読まずここからimportし、必須値の欠落は起動時に例外で気づけるようにする。

function requireString(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Check .env`);
  }
  return value;
}

// Number(raw) || fallbackだと0や"abc"のような不正値が黙って既定値にすり替わるため、
// 未設定時のみ既定値を使い、設定されているのに数値化できない場合は起動時エラーにする
function optionalNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number. Check .env (got "${raw}")`);
  }
  return value;
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const PROJECT_DIR = requireString("PROJECT_DIR");
export const LOGIN_PASSWORD_HASH = requireString("LOGIN_PASSWORD_HASH");
export const SESSION_SECRET = requireString("SESSION_SECRET");
export const TMUX_SESSION_NAME = requireString("TMUX_SESSION_NAME");

export const PORT = optionalNumber("PORT", 8443);
export const MAX_ACTIVE_STREAMS = optionalNumber("MAX_ACTIVE_STREAMS", 3);

// このWebアプリ自身のブラウザウィンドウ等をウィンドウ一覧から除外するためのタイトル部分一致リスト(任意)
export const WINDOW_TITLE_EXCLUDE = splitList(process.env.WINDOW_TITLE_EXCLUDE);

// ffmpegのx11grab接続先(Linuxのみ)。マルチディスプレイ環境等で:0以外の場合のみ.envで上書きする
export const DISPLAY = process.env.DISPLAY || ":0";

export const IS_PRODUCTION = process.env.NODE_ENV === "production";

// ウィンドウ一覧・映像取得・スリープ防止はOSごとにコマンドが異なるため、各モジュールがここで分岐する
export const IS_MAC = process.platform === "darwin";
