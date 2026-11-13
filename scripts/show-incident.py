"""Pretty-print one Firstlook incident from the agent API (stdin: GET /api/incidents/:id)."""
import json
import sys

d = json.load(sys.stdin)
i = d["incident"]
n = i.get("note") or {}
st = i.get("investigation") or {}
print("  %s  (%s tool calls, %.1fs, %s)" % (i["title"], st.get("toolCalls"), st.get("wallMs", 0) / 1000, n.get("author")))
for s in d["steps"]:
    detail = (" — " + s["detail"][:170]) if s.get("detail") and s["kind"] == "tool" else ""
    print("   · " + s["title"] + detail)
if n:
    print("  summary:    " + n["summary"])
    print("  cause:      %s  [%s%s]" % (n["likelyCause"], n["confidence"], ", noise" if n["noise"] else ""))
    for e in n["evidence"]:
        print("  evidence:   %s  (step %s)" % (e["claim"], e.get("step")))
    for r in n["ruledOut"]:
        print("  ruled out:  " + r)
    print("  next step:  " + n["nextStep"])
    for x in n.get("dropped", []):
        print("  DROPPED:    %s — %s" % (x["claim"], x["reason"]))
