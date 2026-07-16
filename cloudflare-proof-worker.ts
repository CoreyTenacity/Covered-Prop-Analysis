// Cloudflare proof-only entrypoint. Vercel and GitHub Actions do not use this file.
// @ts-expect-error OpenNext creates this generated module during the proof build.
import openNextWorker from "./.open-next/worker.js";

type CloudflareExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};

const disabledPrefixes = [
  "/api/cron/",
  "/api/inngest",
  "/api/admin/",
];

function isDisabledPath(pathname: string) {
  return disabledPrefixes.some((prefix) => pathname.startsWith(prefix));
}

export default {
  async fetch(request: Request, env: unknown, ctx: CloudflareExecutionContext) {
    const url = new URL(request.url);
    if (isDisabledPath(url.pathname)) {
      return new Response(
        JSON.stringify({
          error: "This background/admin operation is disabled in the Cloudflare compatibility proof.",
          route: url.pathname,
        }),
        {
          status: 503,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-covered-cloudflare-proof": "disabled",
          },
        },
      );
    }

    return openNextWorker.fetch(request, env, ctx);
  },
};
