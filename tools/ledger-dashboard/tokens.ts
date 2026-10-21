import { randomBytes } from 'node:crypto';

/** Random tokens that each carry a value, can be taken once, and expire `ttlMs` after they are issued. */
export function singleUseTokens<T>(ttlMs: number, now: () => number = Date.now) {
  const issued = new Map<string, { value: T; expires: number }>();
  return {
    issue(value: T): string {
      for (const [token, { expires }] of issued) if (expires <= now()) issued.delete(token);
      const token = randomBytes(32).toString('base64url');
      issued.set(token, { value, expires: now() + ttlMs });
      return token;
    },
    take(token: string): T | null {
      const found = issued.get(token);
      issued.delete(token);
      return found !== undefined && found.expires > now() ? found.value : null;
    },
  };
}
