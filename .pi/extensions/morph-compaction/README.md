# Morph Compaction Extension

Project-local Pi extension that prefers Morph Compact for session compaction without patching the `pi` binary.

How it works:
- Hooks Pi's `session_before_compact` event.
- Sends the older conversation slice Pi was already about to summarize to Morph's `POST /v1/compact` API.
- Stores Morph's verbatim compacted transcript inside Pi's compaction summary slot.
- Falls back to Pi's built-in compaction whenever Morph is disabled, unavailable, or fails.

Feature flag controls:
- persisted config: `~/.pi/agent/morph-compaction.json`
- one-process override: `--compaction-provider morph|pi`
- env override: `PI_COMPACTION_PROVIDER=morph|pi`

Secrets:
- `MORPH_API_KEY` can come from the process environment or the project-local `~/.env` file.
- No Morph credential file is written locally.

Command surface:
- `/compactor`
- `/compactor status`
- `/compactor morph`
- `/compactor pi`

Notes:
- `morph` mode means "try Morph first, then transparently fall back to Pi".
- `pi` mode means "skip Morph entirely".
- `/compactor` reports Pi's end-to-end compaction latency, not just Morph's internal processing time.
- When Morph usage includes `processing_time_ms`, `/compactor` also shows the extra non-engine overhead on top of Morph's own work. That delta includes network round-trip and Pi/runtime overhead, not just local extension time.
- Split-turn compactions stay on Pi's built-in compactor in this v1 because Pi's split-turn prompt is specialized and Morph is a deletion-based compactor, not a summarizer.
- Runtime state is persisted at `~/.pi/agent/morph-compaction-state.json`.
- This extension is auto-loaded because Pi discovers project-local extensions in `.pi/extensions/`.
- Official Morph docs used for this integration:
  - `https://docs.morphllm.com/llms.txt`
  - `https://docs.morphllm.com/sdk/components/compact`
