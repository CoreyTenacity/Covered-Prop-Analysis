import assert from "node:assert/strict";
import test from "node:test";
import { proxyCronJob } from "./cron-proxy.ts";

test("returns a clear error when the cron secret is missing", async () => {
  const old = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const response = await proxyCronJob(new Request("https://example.com/api/cron/refresh-board"), { targetPath: "/api/admin/refresh-board", action: "execute-props" });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("content-type"), "application/json");
  if (old) process.env.CRON_SECRET = old;
});
