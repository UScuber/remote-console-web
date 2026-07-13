import 'dotenv/config';
import express from 'express';
import bcrypt from 'bcrypt';
import { requireAuth, csrfProtection, generateCsrfToken, loginRateLimiter } from './auth/middleware';
import { sessionMiddleware, recordLoginFailure, recordLoginSuccess, SESSION_COOKIE_NAME } from './auth/session';

const PORT = Number(process.env.PORT) || 8443;
const LOGIN_PASSWORD_HASH = process.env.LOGIN_PASSWORD_HASH;

if (!LOGIN_PASSWORD_HASH) {
  throw new Error('LOGIN_PASSWORD_HASH is not set. Check .env');
}

const app = express();
app.use(express.json());

// Tailscale ServeはX-Forwarded-Protoを付与しないため、Secure Cookie送信可否の判定用に自前で補う。
app.use((req, _res, next) => {
  req.headers['x-forwarded-proto'] = 'https';
  next();
});
app.use(sessionMiddleware);

app.get('/', (req, res) => {
  const csrfToken = generateCsrfToken(req);
  const heading = req.session.authenticated ? 'メイン画面(プレースホルダー)' : 'ログインページ(プレースホルダー)';
  res
    .type('html')
    .send(
      `<!doctype html><title>remote-console-web</title><meta name="csrf-token" content="${csrfToken}"><h1>${heading}</h1>`,
    );
});

app.post('/api/login', loginRateLimiter, csrfProtection, async (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const ok = password.length > 0 && (await bcrypt.compare(password, LOGIN_PASSWORD_HASH));
  if (!ok) {
    recordLoginFailure();
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  recordLoginSuccess();
  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ error: 'session_error' });
      return;
    }
    req.session.authenticated = true;
    // regenerate()で旧セッションのCSRFトークンは失われるため、新セッション用に発行し直して返す。
    const csrfToken = generateCsrfToken(req, true);
    res.json({ ok: true, csrfToken });
  });
});

app.post('/api/logout', csrfProtection, requireAuth, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: 'session_error' });
      return;
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`server listening on http://127.0.0.1:${PORT}`);
});
