export function cronAuthorized(authorization: string | null) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  const received = authorization?.replace(/^Bearer\s+/i, "").trim();
  return Boolean(received) && received === expected;
}
