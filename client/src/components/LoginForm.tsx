import { useState } from "react";
import type { FormEvent } from "react";

interface Props {
  csrfToken: string;
  onLoginSuccess: (csrfToken: string) => void;
  /** CSRFトークン失効時(403)にサーバーから取り直した新トークンを親のstateへ反映する */
  onCsrfRefresh: (csrfToken: string) => void;
}

interface LoginResponse {
  ok?: boolean;
  csrfToken?: string;
  error?: string;
  retryAfterMs?: number;
}

async function fetchFreshCsrfToken(): Promise<string | null> {
  try {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data: { csrfToken?: string } = await res.json();
    return data.csrfToken ?? null;
  } catch {
    return null;
  }
}

function LoginForm({ csrfToken, onLoginSuccess, onCsrfRefresh }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        credentials: "same-origin",
        body: JSON.stringify({ password }),
      });
      const data: LoginResponse = await res.json();
      if (!res.ok) {
        if (res.status === 429) {
          const seconds = Math.ceil((data.retryAfterMs ?? 0) / 1000);
          setError(
            `ログイン失敗が続いたためロックされています(${seconds}秒後に再試行可能)`,
          );
        } else if (data.error === "EBADCSRFTOKEN") {
          // サーバー再起動等でCSRFトークンが古くなっているケース。パスワードは無関係なので
          // 「パスワードが違います」とは出さず、新しいトークンを取り直して再送できるようにする
          setError("画面の情報が古くなっています。もう一度お試しください");
          const fresh = await fetchFreshCsrfToken();
          if (fresh) onCsrfRefresh(fresh);
        } else if (res.status === 401) {
          setError("パスワードが違います");
        } else {
          setError("エラーが発生しました。しばらくしてから再度お試しください");
        }
        return;
      }
      if (data.csrfToken) {
        onLoginSuccess(data.csrfToken);
      }
    } catch {
      setError("通信エラーが発生しました");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <h1>remote-console</h1>
      <input
        type="password"
        inputMode="text"
        autoComplete="current-password"
        autoFocus
        placeholder="パスワード"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={submitting}
      />
      <button type="submit" disabled={submitting || password.length === 0}>
        ログイン
      </button>
      {error && <p className="login-error">{error}</p>}
    </form>
  );
}

export default LoginForm;
