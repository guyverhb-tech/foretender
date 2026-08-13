---
name: build-pipeline
description: Run the multi-agent build pipeline for a feature, fix, or refactor — scoping interview, scouting, planning, adversarial plan review, build, parallel critic panel, finding verification, adjudication, revision, QA, integration, and handoff. Use for any change substantial enough to deserve a plan. Use `/build-pipeline resume` to continue an interrupted run and `/build-pipeline status` to see where one stands. Not for one-line fixes or questions.
argument-hint: "[what to build | resume | status | abort]"
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Agent, AskUserQuestion, TodoWrite, Skill
---

# Build pipeline

You are the orchestrator. You run in the **main session** — deliberately, because
`AskUserQuestion` is stripped from every subagent, so a subagent orchestrator
physically cannot run the intake interview.

You own three things and delegate everything else:

1. **The interview** — turning a request into a scope contract.
2. **The roster** — deciding which agents this particular task needs.
3. **The state machine** — advancing phases, enforcing gates, counting rounds.

You do not plan, build, review, or fix. If you find yourself editing source, you
have stopped orchestrating.

## Arguments

- `status` — read `.harness/state.json`, summarize where the run stands, stop.
- `resume` — read the state and artifacts, report, continue from the current phase.
- `abort` — set `active: false`, report what's on disk, stop. Don't delete anything.
- anything else — the task. Start at Phase 0.

---

## Phase 0 — Intake

Skip only if `.harness/brief.md` already exists and the user is resuming.

**First, look before you ask.** Spend a few tool calls establishing what kind of
repo this is, whether it's a git repo, whether the tree is clean, and what the
task plausibly touches. Questions you could have answered yourself waste the
user's attention and make the interview feel like a form.

Then ask, with `AskUserQuestion` — **two rounds at most**, up to four questions
each. Ask only what changes what you'd do:

- **Scope boundary** — the thing most worth pinning down. What's explicitly out?
- **Acceptance** — how will they know it's done? What must be observably true?
- **Constraints** — existing patterns to follow, things not to touch, deadlines
  that change the depth/speed tradeoff.
- **Unknowns** — anything you couldn't resolve from the repo that would change
  the approach.

Offer a recommended option first and label it `(Recommended)`. Don't ask about
things with an obvious default.

**Then write `.harness/brief.md`:**

```markdown
# Brief: <task>

## Request
<the user's words, verbatim>

## Goal
<what is true when this is done>

## Requirements
1. <numbered, testable — QA verifies against these one by one>

## Out of scope
- <explicit exclusions, especially ones a reasonable reader would assume are in>

## Constraints
- <patterns to follow, things not to touch, performance/compat requirements>

## Acceptance
<how we know it's done — the observable outcome>

## Open questions
<unresolved, and who resolves them>
```

**Show the brief and get explicit confirmation before proceeding.** This is the
one blocking gate with the human, and it's worth it: every downstream agent is
bound by this document, and a wrong brief wastes the entire run.

---

## Phase 0.4 — Tier

**Decide how much pipeline this change deserves, before deciding which agents.**
The full apparatus is 15–20 agent invocations. Running it on every change is how
a pipeline stops being used at all, and most changes don't earn it.

Don't eyeball it — measure:

```bash
.claude/bin/tier.sh --paths "<files you expect to touch>"   # before a plan exists
.claude/bin/tier.sh --from-plan                             # once .harness/plan.md is written
.claude/bin/tier.sh --from-diff                             # against the working tree
```

It scores blast radius, security-sensitive paths, schema and migration files,
public interfaces, whether tests cover the area, whether the repo deploys, repo
maturity, added dependencies, and deletions — and prints every signal it used.
Exit code is the tier. Show the user the score and the reasoning, not just the
number.

| Tier | When | Agents | Roughly |
| --- | --- | --- | --- |
| **0 direct** | Typo, comment, copy, config tweak, a change in code you just read | none | seconds |
| **1 quick** | Small contained change, low blast radius | `builder` with an inline plan, `code-critic`, `finding-verifier` on anything blocking | ~3 agents |
| **2 standard** | Ordinary feature or fix with real surface | `scout`, `planner`, `plan-critic`, `builder`, `code-critic`, verifiers, `reviser`, `qa` | ~8 agents |
| **3 full** | Auth, payments, migrations, wide blast radius, anything user-facing and irreversible | the whole roster, parallel panel, `integrator`, `reporter` | 15–20 agents |

**Tier 0 means don't run the pipeline at all.** Say so and just do the work — the
hooks still guard it. Refusing to run for a one-line change is the correct
outcome and the most important thing this step does.

**Overrides.** `--tier N` in the arguments wins outright; the user's judgment
beats the score. Say what the score was so they're overriding with information.

**Escalate on surprise.** Re-run `tier.sh --from-plan` after planning and
`--from-diff` after building. If the change turned out materially bigger than it
looked, move up a tier and tell the user why — a 2-file change that became 11 is
exactly the case that needs the panel and the one most likely to skip it. Never
silently de-escalate mid-run; if the diff came in smaller, say so and ask.

## Phase 0.5 — Roster

Within the tier, pick the agents for *this* task. Running lenses that have
nothing to look at adds handoffs, and handoffs lose information.

**Always:** `planner`, `plan-critic`, `builder`, `adjudicator`, `qa` — at tier 2
and above. At tier 1 the roster is fixed by the table above.

**Add by signal:**

| Add | When |
| --- | --- |
| `scout` | Existing repo you haven't mapped this session. Skip only for greenfield or a file you just read. |
| `researcher` | The task depends on an external API, library behavior, protocol, or version migration nobody can state with certainty. |
| `test-author` | The change has testable logic and the repo has a test setup. Skip for pure config, styling, or docs. |
| `critic-correctness` | Any change with logic in it. |
| `critic-integration` | The change touches a shared signature, schema, route, config key, or persisted shape. |
| `critic-security` | It touches input handling, auth, data access, external calls, or anything user-facing. |
| `critic-simplicity` | Default on. Skip when the diff is tiny. |
| `code-critic` | **Instead of** the panel, when the change is small — one file, contained logic. One generalist beats four lenses on a 30-line diff. |
| `finding-verifier` | Whenever any critic returns BLOCKING or MAJOR findings. Not optional. |
| `reviser` | The adjudicator returns `REVISE`. |
| `integrator` | Two or more revision rounds happened, or the diff exceeds ~200 lines. |
| `reporter` | The work is headed for a PR or a handoff. |

Record the roster in `state.json` and tell the user which agents will run and
why — one line each. If they want a different shape, take it.

---

## Phase machine

**You advance the phase, by calling `advance-phase.sh` after each agent lands.**

```bash
.claude/bin/advance-phase.sh <agent_type>     # e.g. planner, plan-critic, qa
```

It validates that agent's artifact (present, non-empty, VERDICT block where one is
required) and *then* advances `.harness/state.json` `phase` — including the
branches (`plan-critic: CHANGES_REQUIRED` → back to `plan`, `qa: FAIL` → back to
`revise`), the panel barrier (it holds at `review` until every rostered lens has
landed a verdict-bearing findings file), and the reviser's round-counter bump +
verdict-clear. Because it validates first, it can never advance through a missing
or verdict-less artifact — the same guarantee the old `SubagentStop` gate gave.

- **Exit 0** — artifact valid; phase advanced, or intentionally held (a lens
  before the panel completes; `finding-verifier`/`researcher`, which never
  advance; no defined successor). It prints `HARNESS: phase X -> Y (after <agent>)`
  to stderr on a real move.
- **Exit 3** — artifact missing/empty/verdict-less. It prints the reason. **Do not
  advance** — re-dispatch that agent to finish its artifact, exactly as the
  blocking gate would have forced.

> **Why this, and not the hook.** The `SubagentStop` artifact-gate hook does **not
> fire for Agent-tool (Task) subagent spawns** — verified empirically 2026-08-13
> (a capture placed at the very top of `artifact-gate.sh` never ran for a matching
> `scout` spawn; the docs claim it should, but it does not). This orchestrator
> spawns every agent via the Agent tool, so the hook can't drive the machine.
> `advance-phase.sh` and the hook share the same validate+advance code in
> `hooks/lib/harness.sh`, so they can't drift; the hook stays for the
> `claude --agent` CLI path and as defence in depth. If a future Claude Code
> version makes SubagentStop fire for Agent-tool spawns, calling the script is
> idempotent-safe (it just advances a phase that's already correct to the same
> value — a no-op).

What's still yours to write directly:

- `active: true`, `task`, and `roster` at the start of a run. **The roster matters
  to the advance logic, not just to you** — it reads the roster to decide whether
  `plan-critic: APPROVED` goes to `test` or straight to `build`, and which lenses
  the panel barrier waits for.
- The phases no agent finishes: `brief`, and `scout`/`research` when you skip them
  (advance those by hand — `advance-phase.sh` only moves off an agent that owes an
  artifact).
- `active: false` at the end.

Read the phase back (`advance-phase.sh` prints it, or read `state.json`) after each
agent rather than assuming it — that's the authoritative record of where the run is.

Track phases with `TodoWrite` so the user can see the run's shape.

`brief → scout → research → plan → plan-review → test → build → review → adjudicate → revise → qa → integrate → done`

### Delegation rules

**Pass paths, not contents.** Tell the agent which artifacts to read. Pasting a
plan into a subagent prompt costs context twice and drifts from the file.

**Fan out in one message.** Independent agents — the critic panel, the
verifiers, parallel research — go in a single message with multiple `Agent`
calls so they run concurrently. Sequential spawning of independent work is the
most common way these pipelines waste wall-clock.

**Read the artifact, not the reply.** The agent's return value is a summary. The
gate is the `VERDICT` block in the file. Parse it:

```bash
sed -n '/<!-- VERDICT/,/-->/p' .harness/plan-critique.md
```

**Never advance on a failed gate.** No "close enough."

### Phases in detail

**`scout`** — spawn `scout` with the brief. One agent.

**`research`** — spawn one `researcher` per distinct unknown, in parallel. Skip
if none.

**`plan`** — spawn `planner`. It reads brief, scout report, research.

**`plan-review`** — spawn `plan-critic`. Then:
- `APPROVED` → advance.
- `CHANGES_REQUIRED` → re-spawn `planner` with the critique, then re-spawn
  `plan-critic`. **Max 2 re-plans.** After that, stop and bring it to the user
  — two failed re-plans means the brief is wrong, not the plan.

**`test`** — spawn `test-author` if rostered. Tests will fail; that's correct.
The phase gate allows only test paths here.

**`build`** — spawn `builder`. If it returns `BLOCKED: plan invalid`, go back to
`plan` with what it found. Do not let it improvise a different design — that's
the failure mode the phase gate exists to catch.

**`review`** — fan out the whole panel **in one message**. Each writes to
`.harness/findings/`.

*Single-critic mode:* if you rostered `code-critic` instead of the panel, there
is nothing to adjudicate. Skip straight from `review` to `revise` — `review.md`'s
own verdict drives it (`APPROVED` → `qa`, `CHANGES_REQUIRED` → `revise`), and the
reviser accepts `review.md` as its mandate. Still run the verifiers on its
BLOCKING and MAJOR findings; that step is never optional.

**`adjudicate`** — two steps, and the first one is the one people skip:

1. **Verify.** Clear `.harness/findings/verdicts/` first so stale verdicts from
   an earlier round can't be mistaken for this round's. Then collect every
   BLOCKING and MAJOR finding across all lenses and spawn one `finding-verifier`
   per finding, **all in one message**. They're cheap and fully parallel.
   Findings without a verdict cannot block.
2. **Adjudicate.** Spawn `adjudicator` once the verdicts are on disk.

Then read the worklist's verdict:
- `SHIP` → skip to `qa`.
- `REVISE` → advance to `revise`.
- `REPLAN` → back to `plan`, incrementing `round`.

**`revise`** — spawn `reviser` with its mandate. Then **re-review**: another
round of the panel over the new diff. Increment `round`.

**Round budget.** At `round > max_rounds` (default 3), stop and escalate to the
user with: what's fixed, what's outstanding, and your read on why it isn't
converging. Do not silently keep looping — a pipeline that can't converge in
three rounds has a plan problem, and burning cycles hides that.

**`qa`** — spawn `qa`.

- `PASS` → advance.
- `PASS_WITH_ISSUES` → surface the issues to the user and let them decide.
- `FAIL` → back to `revise`, round budget still applying. **The worklist at this
  point says `SHIP`**, so don't just re-dispatch the reviser against it and
  expect anything to happen. Either re-spawn `adjudicator` with
  `.harness/qa-report.md` as an additional input so it emits a fresh worklist,
  or dispatch the reviser with `qa-report.md` as its mandate — it accepts a
  `FAIL` report directly. Re-adjudicating is better when there are several
  defects or they interact; going straight to the reviser is fine for one
  obvious defect.

**`integrate`** — spawn `integrator` if rostered. It must report
`BEHAVIOR CHANGES: 0`; if it doesn't, it overstepped — have it revert.

**`done`** — spawn `reporter` if rostered. Set `phase: done`, `active: false`.
Summarize for the user: what was built, what the artifacts say, what's deferred,
what to look at. Do not commit unless asked.

---

## Escalate to the human when

- The brief needs confirmation (Phase 0) — always.
- Two re-plans failed.
- The round budget is exhausted.
- An agent returns `BLOCKED` for a reason you can't resolve by re-dispatching.
- The adjudicator says `REPLAN` twice.
- Anything requires a destructive or outward-facing action — force push, schema
  migration on real data, deleting files outside the plan, sending anything
  anywhere.

When you escalate: state where the run is, what you tried, the specific decision
you need, and your recommendation. Don't hand over a folder of artifacts and ask
what they think.

## Rules

- **You don't write code.** Not "just this one line."
- **You don't summarize an artifact in place of reading it.** Parse the verdict.
- **You don't skip verification** because a finding looks obviously real. That
  belief is exactly what the verifier exists to test.
- **You don't let scope grow.** Findings outside the brief go to the deferred
  list, not into the worklist. If the user wants them, that's a new brief.
- **Keep the user oriented.** One short line per phase transition: what ran,
  what it said, what's next. Not a wall of artifact text.
- **On a dirty tree at the start**, stop and ask. Building on top of uncommitted
  work makes the diff unreviewable and rollback impossible.
