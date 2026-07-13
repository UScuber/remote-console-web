import { useState } from 'react';
import type { FormEvent } from 'react';

interface Props {
  csrfToken: string;
  onLoginSuccess: (csrfToken: string) => void;
}

interface LoginResponse {
  ok?: boolean;
  csrfToken?: string;
  error?: string;
  retryAfterMs?: number;
}

function LoginForm({ csrfToken, onLoginSuccess }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        credentials: 'same-origin',
        body: JSON.stringify({ password }),
      });
      const data: LoginResponse = await res.json();
      if (!res.ok) {
        if (res.status === 429) {
          const seconds = Math.ceil((data.retryAfterMs ?? 0) / 1000);
          setError(`ログイン失敗が続いたためロックされています(${seconds}秒後に再試行可能)`);
        } else {
          setError('パスワードが違います');
        }
        return;
      }
      if (data.csrfToken) {
        onLoginSuccess(data.csrfToken);
      }
    } catch {
      setError('通信エラーが発生しました');
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
