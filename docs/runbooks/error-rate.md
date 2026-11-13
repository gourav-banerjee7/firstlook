# Runbook: high 5xx error rate

1. **Which routes and which errors?** Group error logs by message.
2. **Is it us or a dependency?** Compare the payment provider's failure ratio with our own errors.
3. **Is it still happening?** A short spike that has already recovered may be noise; note it and move on.
4. **Mitigate.** Roll back a bad deploy, or degrade gracefully while a dependency recovers.
