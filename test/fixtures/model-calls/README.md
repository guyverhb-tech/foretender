# Model-call fixtures

Canned Anthropic Messages API responses used by the model-predictor contract
tests (Phase 1 slice 7). Unlike the FTS corpus in the sibling fixture
directories, these are **synthetic** — hand-authored to the verified wire shape
(`.harness/research/anthropic-api.md`), NOT recorded from a live call (no key was
available at authoring time). They are therefore deliberately absent from
`../checksums.sha256`, which pins the real Phase 0 FTS recordings only.

Each file is a complete non-streaming `POST /v1/messages` response body. The
generated text lives at `content[0].text` and is itself a strict JSON string
`{"probability": <0..1>, "rationale": "<short>"}` — the exact structured output
the predictor parses. The deterministic mock/recorded model client
(`test/helpers/model-client.ts`) returns these bytes verbatim so predictions are
produced with zero network and zero spend (the `test/setup.ts` fetch poison
stays unfired).

- `valid-response.json` — `stop_reason: "end_turn"`, `probability: 0.42`. 0.42
  is distinct from every baseline prior (0.067 / 0.034 / 0.165 / 0.05), so a
  model prediction and its baseline sibling stay separable in the head-to-head
  scoreboard (they cannot silently collide on an identical Brier).
