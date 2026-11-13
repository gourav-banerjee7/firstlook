# Runbook: high P99 latency

1. **Scope it.** Which routes are slow? (dashboard panel "Latency P99 by route and version")
2. **What changed?** Check the deploy markers. A new version just before the spike is the usual suspect.
3. **Where is the time going?** Open a slow trace: database span, downstream call, or the service itself.
4. **Mitigate.** If a deploy is to blame, roll it back. If a dependency is slow, check its status and consider
   shedding or caching. If the database is slow, look for a new query or a missing index.
