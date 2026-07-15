import { csrfSync } from "csrf-sync";
import { parseCookie } from "cookie";
import { unsign } from "cookie-signature";
import type { Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "http";
import {
  SESSION_COOKIE_NAME,
  sessionStore,
  getLoginLockRemainingMs,
} from "./session";
import { SESSION_SECRET } from "../config";

const { csrfSynchronisedProtection, generateToken } = csrfSync();

export const csrfProtection = csrfSynchronisedProtection;
export const generateCsrfToken = generateToken;

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.authenticated) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

// WebSocketアップグレード要求はExpressのResponseを持たずsessionMiddlewareを通せないため
// Cookie署名検証・セッション照会をここで直接行う(詳細はserver/README.md)
export function isRequestAuthenticated(req: IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    const cookieHeader = req.headers.cookie;
    const raw = cookieHeader
      ? parseCookie(cookieHeader)[SESSION_COOKIE_NAME]
      : undefined;
    if (!raw || !raw.startsWith("s:")) {
      resolve(false);
      return;
    }
    const sessionId = unsign(raw.slice(2), SESSION_SECRET);
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
      // sessionMiddlewareのrolling更新はHTTP経路にしか効かないためここでも呼ぶ
      sessionStore.touch?.(sessionId, sess, () => {});
    });
  });
}

export function loginRateLimiter(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const remainingMs = getLoginLockRemainingMs();
  if (remainingMs > 0) {
    res.set("Retry-After", String(Math.ceil(remainingMs / 1000)));
    res.status(429).json({ error: "locked", retryAfterMs: remainingMs });
    return;
  }
  next();
}
