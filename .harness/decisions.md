# Decisions ledger

Append-only. The adjudicator writes here; critics read it before raising a finding.

This is the only file in `.harness/` that persists across runs, and it's the reason round 3 doesn't
relitigate round 1 — and run 20 doesn't relitigate run 1. **Commit it.**

Prune it occasionally: the value is in the recent, still-relevant entries. An entry whose code no
longer exists is just noise.

Format:

```markdown
## Round <N> — <YYYY-MM-DD>
- **<FINDING-ID> — <title>** — DROPPED (refuted): <reason> — do not re-raise without <what would change it>
- **<FINDING-ID> — <title>** — DEFERRED: out of scope per brief §<x> — tracked in <where>
- **<ID-A> vs <ID-B>** — RESOLVED in favor of <ID-A>: <reason>
- **<decision>** — ACCEPTED: <the deliberate choice, and why it looks wrong but isn't>
```

---
