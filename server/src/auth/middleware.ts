import { csrfSync } from 'csrf-sync';
import { parseCookie } from 'cookie';
import { unsign } from 'cookie-signature';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'http';
import { SESSION_COOKIE_NAME, sessionSecret, sessionStore, getLoginLockRemainingMs } from './session';

const { csrfSynchronisedProtection, generateToken } = csrfSync();

// 状態を変更するエンドポイント用のCSRFチェック(Synchronizer Token Pattern、トークンはセッションに保持)
export const csrfProtection = csrfSynchronisedProtection;
export const generateCsrfToken = generateToken;

// 全ルートで共通利用する認証チェック(Express用)
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.authenticated) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

// WebSocketアップグレード要求(生のIncomingMessage)向け。Step 3以降で使用する。
// express-sessionの内部処理(Cookie署名検証・ストア照会)と同じ手順を直接行う。
// 偽のResponseオブジェクトをミドルウェアに通す方式は、on-headers等がresのメソッドに
// 触れた際に壊れやすいため避け、cookie/cookie-signatureで最小限の検証のみ行う。
export function isRequestAuthenticated(req: IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    const cookieHeader = req.headers.cookie;
    const raw = cookieHeader ? parseCookie(cookieHeader)[SESSION_COOKIE_NAME] : undefined;
    if (!raw || !raw.startsWith('s:')) {
      resolve(false);
      return;
    }
    const sessionId = unsign(raw.slice(2), sessionSecret);
    if (sessionId === false) {
      resolve(false);
      return;
    }
    sessionStore.get(sessionId, (err, sess) => {
      if (err || !sess) {
        resolve(false);
        return;
      }
      resolve(Boolean(sess.authenticated));
      // HTTP経由のアクセスと同様、参照のたびにスライディング延長する。
      sessionStore.touch?.(sessionId, sess, () => {});
    });
  });
}

// ログインエンドポイント専用のレートリミット(連続失敗によるロックアウト)
export function loginRateLimiter(_req: Request, res: Response, next: NextFunction): void {
  const remainingMs = getLoginLockRemainingMs();
  if (remainingMs > 0) {
    res.set('Retry-After', String(Math.ceil(remainingMs / 1000)));
    res.status(429).json({ error: 'locked', retryAfterMs: remainingMs });
    return;
  }
  next();
}
