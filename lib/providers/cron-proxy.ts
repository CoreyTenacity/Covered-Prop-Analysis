export async function proxyCronJob(request: Request, input: { targetPath: string; action: string }) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return new Response(JSON.stringify({ error: "CRON_SECRET is not configured." }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });

  const response = await fetch(new URL(input.targetPath, request.url), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: input.action }),
    cache: "no-store",
  });

  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "application/json";
  return new Response(text, {
    status: response.status,
    headers: { "content-type": contentType },
  });
}
