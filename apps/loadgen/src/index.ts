/**
 * loadgen: steady, realistic traffic against demo-api, so dashboards and alerts have something to say.
 * Mostly reads, some bookings (which call the payment provider).
 */
const target = process.env.TARGET_URL ?? "http://localhost:8081";
const rps = Number(process.env.RPS ?? 12);
const writeShare = Number(process.env.WRITE_SHARE ?? 0.2);

let sent = 0;
let failed = 0;

async function one() {
  const write = Math.random() < writeShare;
  try {
    const res = write
      ? await fetch(`${target}/bookings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workerId: Math.floor(Math.random() * 400),
            amountCents: 2500 + Math.floor(Math.random() * 9000),
          }),
          signal: AbortSignal.timeout(8000),
        })
      : await fetch(`${target}/bookings?worker_id=${Math.floor(Math.random() * 400)}`, {
          signal: AbortSignal.timeout(8000),
        });
    if (!res.ok) failed++;
    await res.arrayBuffer();
  } catch {
    failed++;
  }
  sent++;
}

setInterval(() => {
  // Poisson-ish: a little jitter around the target rate.
  const n = Math.max(0, Math.round(rps * (0.8 + Math.random() * 0.4)));
  for (let i = 0; i < n; i++) setTimeout(() => void one(), Math.random() * 1000);
}, 1000);

setInterval(() => {
  console.log(JSON.stringify({ time: new Date().toISOString(), service: "loadgen", sent, failed }));
  sent = 0;
  failed = 0;
}, 30_000);

console.log(JSON.stringify({ service: "loadgen", msg: "started", target, rps }));
