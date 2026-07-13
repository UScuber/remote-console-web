import 'dotenv/config';
import { createServer } from 'node:http';
import express from 'express';
import bcrypt from 'bcrypt';
import { WebSocketServer } from 'ws';
import { requireAuth, csrfProtection, generateCsrfToken, loginRateLimiter, isRequestAuthenticated } from './auth/middleware';
import { sessionMiddleware, recordLoginFailure, recordLoginSuccess, SESSION_COOKIE_NAME } from './auth/session';
import { registerTerminalWebSocket } from './terminal/ptyManager';

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

const server = createServer(app);

const terminalWss = new WebSocketServer({ noServer: true });
registerTerminalWebSocket(terminalWss);

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '', 'http://localhost');

  if (pathname !== '/ws/terminal') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  isRequestAuthenticated(req)
    .then((authenticated) => {
      if (!authenticated) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        terminalWss.emit('connection', ws, req);
      });
    })
    .catch(() => {
      socket.destroy();
    });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`server listening on http://127.0.0.1:${PORT}`);
});
