/**
 * Same-origin proxy to the Firstlook agent, for self-hosted deployments (the Helm chart): the browser
 * talks to the Incident Room only, and the server forwards /api/* to AGENT_URL at runtime. Streams
 * responses, so the SSE timeline works through it. Without AGENT_URL (e.g. the public recorded demo)
 * it's a 404.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED = /^(incidents(\/[\w-]+(\/(stream|feedback|reinvestigate))?)?|scenarios\/[\w-]+)$/;

async function forward(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const agent = process.env.AGENT_URL;
  const path = (await params).path.join("/");
  if (!agent || !ALLOWED.test(path)) return new Response("not found", { status: 404 });
  const url = new URL(`/api/${path}${new URL(req.url).search}`, agent);
  const upstream = await fetch(url, {
    method: req.method,
    headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
    ...(req.method === "POST" ? { body: await req.text() } : {}),
    signal: req.signal,
  }).catch(() => undefined);
  if (!upstream) return new Response(JSON.stringify({ error: "agent unreachable" }), { status: 502 });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-cache, no-transform",
      ...(upstream.headers.get("retry-after") ? { "retry-after": upstream.headers.get("retry-after")! } : {}),
    },
  });
}

export { forward as GET, forward as POST };
