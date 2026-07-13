import './loadEnv';
import path from 'node:path';
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

// Tailscale ServeはX-Forwarded-Protoを付与しないため、本番でのみSecure Cookie判定用に自前で補う
if (process.env.NODE_ENV === 'production') {
  app.use((req, _res, next) => {
    req.headers['x-forwarded-proto'] = 'https';
    next();
  });
}
app.use(sessionMiddleware);

// クライアント(SPA)は/api/sessionで認証状態とCSRFトークンを取得してから描画を分岐する。
app.get('/api/session', (req, res) => {
  const csrfToken = generateCsrfToken(req);
  res.json({ authenticated: Boolean(req.session.authenticated), csrfToken });
});

// ビルド済みクライアント(client/dist)を配信する。'/'はexpress.staticがindex.htmlを自動応答する。
const CLIENT_DIST_DIR = path.resolve(__dirname, '../../client/dist');
app.use(express.static(CLIENT_DIST_DIR));

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

// エラー発生時もJSONで返す(デフォルトのHTMLエラーページだとクライアントでres.json()が失敗する)
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'internal_error';
  res.status(status).json({ error: code });
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
