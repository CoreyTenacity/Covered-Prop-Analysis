import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
  // The proof intentionally avoids R2/KV/D1 and uses only in-memory cache behavior.
  incrementalCache: "dummy",
  queue: "direct",
  routePreloadingBehavior: "none",
});
