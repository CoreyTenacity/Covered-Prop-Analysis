import { normalizedSecret } from "./env.ts";

export function refreshAuthorized(authorization: string | null) {
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const allowed = [normalizedSecret(process.env.ADMIN_REFRESH_SECRET), normalizedSecret(process.env.CRON_SECRET)].filter(Boolean);
  if (!supplied || allowed.length === 0) return false;
  return allowed.some((secret) => secret === supplied);
}
