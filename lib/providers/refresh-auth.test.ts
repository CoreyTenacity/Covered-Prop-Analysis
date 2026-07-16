import assert from "node:assert/strict";
import test from "node:test";
import { refreshAuthorized } from "./refresh-auth.ts";

test("refresh access is closed when no secret is configured", () => {
  const oldAdmin = process.env.ADMIN_REFRESH_SECRET;
  const oldCron = process.env.CRON_SECRET;
  delete process.env.ADMIN_REFRESH_SECRET;
  delete process.env.CRON_SECRET;
  assert.equal(refreshAuthorized("Bearer anything"), false);
  if (oldAdmin) process.env.ADMIN_REFRESH_SECRET = oldAdmin;
  if (oldCron) process.env.CRON_SECRET = oldCron;
});

test("accepts only a configured bearer secret", () => {
  const oldAdmin = process.env.ADMIN_REFRESH_SECRET;
  process.env.ADMIN_REFRESH_SECRET = "test-admin-secret";
  assert.equal(refreshAuthorized("Bearer wrong"), false);
  assert.equal(refreshAuthorized("Bearer test-admin-secret"), true);
  if (oldAdmin) process.env.ADMIN_REFRESH_SECRET = oldAdmin;
  else delete process.env.ADMIN_REFRESH_SECRET;
});

