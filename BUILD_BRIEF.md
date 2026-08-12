# Public Procurement Intelligence — Build Brief

**Read this fully before writing any code.** This document is the source of truth for what we are building and why. Where it conflicts with your instincts, raise the conflict rather than resolving it silently.

---

## 1. What this is

A system that watches the UK public procurement notice stream, maintains a longitudinal model of every procurement it sees, makes falsifiable predictions about what those procurements will do next, and is graded automatically when reality arrives.

Later phases add proactive asset generation for suppliers. **Not yet.** See §8.

## 2. Why it exists

Two goals, in priority order:

1. **Learning goal (primary).** Gain hands-on experience building long-running autonomous agents: durable execution, self-scheduled wake, crash recovery, state migration while work is in flight, and detecting silent degradation.
2. **Product goal (secondary).** Produce something a supplier bidding for public contracts would genuinely find valuable.

When these two conflict, the learning goal wins. Prefer the architecture that teaches the harder lesson over the one that ships faster.

## 3. The core reframe

**The unit of the system is the procurement, not the notice.**

A notice is an event. A procurement is a long-lived object that emits notices across its lifetime: announced as a pipeline notice, published as a tender notice, amended repeatedly, resolved by an award notice, then modified or re-let years later.

The system tracks thousands of these concurrently, each waking on external events at unpredictable intervals over 6-24 month lifespans. **This is the durable execution problem, and it is the point of the project.** Do not flatten procurements into a table of notices.

## 4. Ground truth about the data

Facts are marked by confidence. **Anything marked ASSUMED must be verified in Phase 0 before anything depends on it.**

**VERIFIED:**
- Find a Tender Service (FTS) relaunched 24 February 2025 as the Central Digital Platform under the Procurement Act 2023.
- FTS now publishes both above- and below-threshold notices, except below-threshold notices in Scotland.
- It is free to use. There are no charges for viewing opportunities.
- Notice records carry OCID identifiers (`ocds-...`), so the data follows the Open Contracting Data Standard.
- Notices are versioned. Edited notices retain prior versions, and both are retrievable.
- Notice types across the lifecycle include pipeline notices, tender notices, and contract award notices.
- Structured fields on notices include estimated total value, contract start/end dates, possible extensions, CPV classifications, procurement category, and submission deadline.
- Live production data contains obvious junk: £0 values, mismatched CPV codes, descriptions reading "test".

**ASSUMED — verify in Phase 0:**
- That a bulk download or API endpoint exists for notice retrieval, and its rate limits.
- The exact shape of the OCDS release package FTS emits, and which OCDS extensions are in use.
- That pipeline notices are published in meaningful volume. **This is the single biggest kill-risk in the project** — the flagship prediction in §6 depends on it. The Act requires them; compliance may be patchy. Measure it before building on it.
- That award notices reliably publish the winning supplier and final value.
- Whether bidder counts are published on award notices.
- Whether Scottish below-threshold notices need a separate source (Public Contracts Scotland).

**Do not fabricate OCDS field names.** Read the published standard. If a field this brief references does not exist in the real payload, stop and report.

## 5. Architecture principles — non-negotiable

### 5.1 Enforced isolation

The previous build this is modelled on failed because heavy interdependencies made components impossible to isolate and test. That must not happen again.

Six layers. Each has an explicit contract, its own tests, and can be exercised against recorded fixtures with every other layer absent:

| Layer | Responsibility | Must NOT know about |
|---|---|---|
| **Ingest** | Network, fetching, parsing, normalising to canonical form | Predictions, lifecycle, generation |
| **Store** | Canonical model + append-only event log | Why anything is being stored |
| **Lifecycle** | Pure state machine over events. Deterministic, zero I/O | Where events came from |
| **Prediction** | Reads store, emits predictions with confidence | How predictions get graded |
| **Grading** | Reads predictions + store, emits verdicts. Deterministic | How predictions were made |
| **Generation** | Agents. Reads everything, produces assets | — nothing depends on it |

Dependencies point downward only. Generation is built last, and removing it entirely must leave a working system.

### 5.2 Deterministic core, agents at the edges

Ingest, store, lifecycle, and grading are ordinary deterministic code. They fail loudly. Only prediction and generation involve models. This is deliberate: the parts that tell you the system is broken must not themselves be non-deterministic.

### 5.3 The ledger

Every model call, every tool call and its raw response, every prediction, every action, and every verdict is appended to an immutable log with a timestamp, the prompt version, and the model version. Tool responses are recorded such that they can be replayed. **Deterministic replay is a foundational decision, not a later feature** — retrofitting it is not realistically possible, so build the store to support it from the first commit.

### 5.4 The lifecycle machine will meet dirty reality

Real notices arrive out of order, skip states, contradict earlier versions, and reference procurements you have never seen. The state machine must tolerate all of this and record the anomaly rather than crashing or silently coercing. Anomaly rate is itself a health metric.

## 6. The prediction ladder

Every prediction is recorded with an explicit confidence and an expected resolution date. Verdicts arrive free from published data.

| Horizon | Prediction | Graded by |
|---|---|---|
| Days | This tender will be amended or its deadline extended | Notice version history |
| Weeks-months | This pipeline notice converts to a real tender, at time T, at value V | Appearance of the tender notice |
| Months | Who wins, and at what value relative to estimate | Award notice |
| Years | This contract will be modified, extended, or re-let on schedule | Modification / subsequent notices |

Two tiers, deliberately:
- **High-frequency, cheap predictions** keep the system calibrated and give enough volume to detect drift.
- **Low-frequency, high-value predictions** are the ones a user would act on. They earn trust from the accumulated calibration record of the cheap ones, not from sounding plausible.

Measure **calibration**, not just accuracy — a system that stays 70% right but stops knowing when it is uncertain is degrading, and accuracy alone hides that entirely. Brier score over resolved predictions, segmented by prediction type.

## 7. Phases

### Phase 0 — Verify (do this first, write almost no code)
Resolve every ASSUMED item in §4. Produce a short findings file recording what is actually true, with evidence. **If pipeline notices turn out to be rare, stop and escalate before proceeding** — the design changes materially.

### Phase 1 — Ingest, lifecycle, one prediction
- Ingest and normalise the notice stream into the canonical model
- Append-only event store with replayable fixtures
- Lifecycle state machine
- Exactly one prediction type: pipeline-to-tender conversion
- Grading loop that resolves those predictions against reality
- No agents. No generation. No UI beyond whatever is needed to read the scoreboard.

Phase 1 is the supervised end-to-end run. Getting a graded scoreboard before writing a single prompt is the goal, not a limitation.

### Phase 2 — Breadth and durability
Additional prediction types up the ladder. Self-scheduled wake. Crash recovery and resume. Golden-set replay against recorded fixtures to catch degradation when the underlying model changes beneath you.

### Phase 3 — Generation
Agents that decide unprompted that a procurement warrants an asset, and produce it. Only after the scoreboard has been running long enough to be trusted.

## 8. Non-goals

Do not build these unless explicitly told to:
- Any user interface beyond the minimum to inspect the scoreboard
- Supplier-specific qualification ("should *we* bid on this") — this needs a real supplier subject, which is currently an open question. The market predictions in §6 are subject-independent and are what Phase 1 and 2 rely on.
- Asset generation of any kind before Phase 3
- Authentication, multi-tenancy, deployment infrastructure
- Anything requiring paid data sources

## 9. Anti-fabrication rules

The previous build suffered from tests that passed without testing, and components reported as wired up that were not. Explicitly:

- A test that does not assert against real recorded fixture data does not count as a test.
- No component may be reported complete until its contract test runs green against fixtures, in isolation, with its neighbours absent.
- Never report a component as integrated without an executed end-to-end run producing real output.
- If a data source does not behave as this brief describes, **stop and report**. Do not adapt around it silently.
- If you are uncertain whether something works, say so. An accurate "I have not verified this" is more valuable than a confident claim that turns out false.

## 10. Open questions — do not resolve these silently

1. Is there a real supplier business this will eventually serve, or is the subject hypothetical? Affects Phase 3 only.
2. Language and runtime are not yet fixed. Raise a recommendation with reasoning before choosing.
3. Incumbents exist in UK procurement intelligence (Stotles and Tussell are the likely names, unverified). Worth a look during Phase 0 for what they surface and what they miss — not to compete, but to avoid rebuilding the obvious.

## 11. Definition of done — Phase 1

- Notice stream ingests and normalises cleanly, with junk records quarantined rather than dropped
- Lifecycle machine reconstructs procurement state from the event log deterministically, and a full replay from fixtures reproduces identical state
- Pipeline-to-tender predictions are recorded with confidence and expected resolution date
- Grading loop has resolved at least one real prediction against a real subsequent notice
- Every layer's contract tests pass in isolation
- A written summary of what the scoreboard says so far, including calibration, not just hit rate
