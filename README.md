# review-collaboration

A [Claude Code](https://claude.com/claude-code) skill that puts a conclusion you and Claude just reached in front of an **independent AI reviewer** (currently [Codex CLI](https://github.com/openai/codex)) before you commit to it — a second, genuinely different set of eyes, not a rubber stamp.

## Why

Claude can be confidently wrong in ways that are hard to catch from inside the same conversation that produced the conclusion — the blind spot is the discussion's own framing, not any one fact. This skill hands a neutralized summary of the discussion to a different model/vendor and runs a structured, multi-round negotiation: the reviewer raises objections, Claude fixes or pushes back with reasoning, repeat until the reviewer stops raising new unconceded objections — or a round cap is hit and you decide how to proceed.

## What it actually does

- **Anonymizes** the discussion into a neutral review package before it ever leaves the conversation (no attribution, no verbatim transcript dump).
- Forces an explicit **verification tag** on every assumption (verified / verifiable-but-unverified / judgment call) — the reviewer's job includes auditing whether *these tags themselves* look wrong, not just the conclusion.
- Runs the round-trip negotiation through a small **PowerShell CLI + JSON-schema state machine** (`scripts/review-collab.ps1`), so progress survives a session interruption — not hand-tracked prose.
- Calls the reviewer from an isolated, disposable working directory — the project this skill maintains directly observed the reviewer wandering into unrelated files when given a confusing prompt, so it never runs from inside your real project.
- Stops and hands control back to **you** at a round/material cap, never silently declares consensus to end the loop.

## When to use it

You're in a Claude Code session, you and Claude just converged on a conclusion for something that matters (a design decision, an architectural choice, a plan), and you want a real second opinion before it's final — not another paraphrase from the same model that produced it.

Not for: reviewing a file/spec that already exists on disk with no live discussion behind it (that's a different kind of tool) — this skill reviews the *conclusion of a conversation*.

## Requirements

- Windows, PowerShell 5.1 (all encoding/argument-binding workarounds in this codebase are written for it specifically — see `docs/session-log.md` for the exact bugs hit and fixed).
- [Codex CLI](https://github.com/openai/codex) installed and authenticated (`codex --version` should work in a fresh shell).
- Claude Code.

## Install

```powershell
git clone https://github.com/JuiMingWang/review-collaboration.git "$env:USERPROFILE\.claude\skills\review-collaboration"
```

That's it — scripts, schemas, and tests all ship alongside `SKILL.md` in this same repo, nothing else to configure.

## Use

Inside a Claude Code session, once you and Claude have a conclusion worth a second opinion, just ask for it explicitly — e.g. *"review this with review-collaboration"*. The skill never triggers itself (`disable-model-invocation: true` in `SKILL.md`'s frontmatter) — it only runs when you ask.

## Status

- 92 automated Pester tests, all passing (`tests/`).
- Verified once end-to-end against the real Codex CLI, including the working-directory isolation guarantee (confirmed via the reviewer's own logs that its filesystem-exploration attempts were blocked).
- Early / lightly used — `docs/review-log.md` in a target project accumulates real usage over time; treat conclusions from this skill as a structured second opinion, not a proven-calibrated instrument yet (see the "Known limitation" note near the top of `SKILL.md`).
- Design rationale for every mechanism lives in [`CONTEXT.md`](./CONTEXT.md) and [`docs/adr/`](./docs/adr/) — if something in `SKILL.md` looks arbitrary, that's where the "why" is.

## Contributing

This is an early, personally-maintained project — issues and PRs (especially real usage reports, edge cases the round-cap/material-cap logic doesn't handle well, or a Linux/macOS port of the PowerShell layer) are welcome.

## License

MIT — see [LICENSE](./LICENSE).
