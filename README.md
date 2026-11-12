# Firstlook

**An AI first responder for on-call.** When an alert fires, Firstlook investigates the way a good engineer
does in their first ten minutes (metrics, logs, traces, what changed), then writes a triage note where every
claim links to the evidence. It stays on the incident until it resolves. It reads; it never changes anything.

> 🚧 **Status: Phase 0 — foundations.** See the [implementation plan](docs/PLAN.md) and the
> [milestones](https://github.com/gourav-banerjee7/firstlook/milestones) for progress.

## What it will do

1. **Wake up on an alert** from Grafana, ignoring duplicates and grouping related alerts into one incident.
2. **Investigate** with read-only tools: metric shape and onset, breakdown by route and pod, error logs
   grouped by signature, slow traces, recent deploys, dependency health.
3. **Write a triage note:** likely cause with a confidence level, evidence links for every claim, what it
   ruled out, and a suggested next step.
4. **Stay on the incident:** update as it recovers, answer follow-up questions, draft the postmortem timeline.
5. **Get measurably better:** each incident becomes an eval case, scored in Langfuse.

You'll be able to watch it work in the **Incident Room**: break the demo system with one click and see the
alert fire, the agent investigate step by step, and the triage note appear, along with a GitHub issue and a
Grafana annotation.

## Stack

Open source and free to run: OpenTelemetry, Prometheus, Loki, Tempo, Grafana (configured with Terraform),
Postgres, Langfuse, Gemini (free tier) or Ollama, Next.js, Docker Compose, Helm on k3s.

## License

MIT
