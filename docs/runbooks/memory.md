# Runbook: memory near limit

1. **Is it growing steadily?** A sawtooth that resets with process restarts means it's being OOM-killed.
2. **Since when?** Line the growth up with deploys; a new cache or buffer is a common cause.
3. **Mitigate.** Roll back the change that introduced the growth; raise the limit only as a stopgap.
