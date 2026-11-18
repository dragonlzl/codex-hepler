# Codex model metadata

`codex-models.json` is the unmodified model catalog from [openai/codex](https://github.com/openai/codex), commit `3aaa23a437f6a0e6ab224163a2e36fd95ff73804` (retrieved 2026-11-18).

Source: https://raw.githubusercontent.com/openai/codex/3aaa23a437f6a0e6ab224163a2e36fd95ff73804/codex-rs/models-manager/models.json

SHA-256: `d50b6749506d97e5f334dbabcb666eb1689f423cf3e88cfabdcf3c536b873068`

The upstream Apache 2.0 license is included in `codex-models.LICENSE`. Model instructions and capabilities are retained together; do not synthesize capabilities by copying an unrelated model. The runtime intersects this metadata (plus compatible entries from the user's Codex cache) with the active relay's advertised model IDs. Upstream availability does not establish successful inference.

To update, replace the catalog from a reviewed upstream commit, update this provenance and digest, and run the model catalog regression and installed Codex integration tests.
