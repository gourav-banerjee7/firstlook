# Evals

Recorded incidents (`cases/*.json`) replayed through a planner and graded.

```bash
pnpm --filter @firstlook/agent eval                              # playbook (what CI runs)
GEMINI_API_KEY=... EVAL_REPEATS=3 pnpm --filter @firstlook/agent eval
EVAL_OLLAMA=1 OLLAMA_MODEL=qwen2.5:7b pnpm --filter @firstlook/agent eval
```

Results land in `results.md` / `results.json`. With `LANGFUSE_*` set, each case is an item in the
`firstlook-incidents` dataset and each run is linked to it with an `eval_pass` score.

## Adding a case

Run a scenario on the compose stack (`./scripts/e2e.sh <scenario>`), then capture it while the telemetry
is still in Prometheus, Loki and Tempo:

```bash
echo "bad-deploy inc_20261113_2d523f" > ids.txt
pnpm --filter @firstlook/agent eval:capture ids.txt
```

Ground truth per scenario lives in `src/evals/cases.ts` (`EXPECT`); the agent never sees it.

## Does it catch regressions?

Mutation check, done when this landed: each change below makes `pnpm eval` exit 1.

| Change to the playbook              | Caught by                                                |
| ----------------------------------- | -------------------------------------------------------- |
| Ignore dependency health            | `dependency-outage` → cause: blamed the rollback (decoy) |
| Call noise only after full recovery | `noisy-blip` → noise: false, expected true               |
