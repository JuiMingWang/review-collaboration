# Tool map: understand the function before the name

[English guide](README.md) · [繁體中文](../TOOLS.md)

The host and delegate normally call `scripts/review-mail.ps1` with a UTF-8 JSON request. An **action** is the operation requested from the program; it is not another agent or a background service. The entry point locates its modules relative to the installed package.

| Action | Function | Conditions and result | Diagram |
| --- | --- | --- | --- |
| `resolve` | Read saved reviewer preferences and routes for this host tool. | No choice gives `selection-required`; no prompt is sent. | [02a](02a-selection.html): resolve |
| `authenticate` | `inspect` lists advertised login methods; `login` invokes a verified method. | Zero sessions/prompts; authenticated is not live proof. | [02b](02b-connection.html): inspect, login |
| `probe` | `initialize` checks the handshake; `live` checks a fixed synthetic exchange. | Initialize sends no prompt; live verification requires authorization and complete receipts. | [02b](02b-connection.html): initialize, live |
| `profile-set` | Permanently update the host tool's default reviewer. | Requires `expected_revision`; a one-run override does not change this default. | [02a](02a-selection.html): saving a choice |
| `project-init` | Create or verify the project's private record root. | Records stay outside the skill package. | [03](03-handoff.html): project |
| `topic-create` | Create a topic for a different decision; link related topics where useful. | The same decision can reuse its existing topic. | [03](03-handoff.html): topic |
| `run-open` | Save the host key, reviewer, route, settings, and deadline for this run. | A new host session needs a new run; active settings do not follow later preference edits. | [03](03-handoff.html): run |
| `exchange` | Archive an authorized letter, send once, receive and check the result. | Repeating the same exchange inspects original state rather than resending. | [05a](05a-send.html): steps 1–6 |
| `status` | Read run/exchange state and completion evidence. | No prompt; `reply-ready` does not establish content correctness. | [06](06-recovery.html): status, result |
| `cancel` | Write a cancellation request. | No new prompt; a marker does not prove the reviewer stopped. | [06](06-recovery.html): cancel, stopped |
| `recover` | Check the original invocation, lock, and receipts; finalize if supported. | No prompt or resend; missing evidence remains unknown. | [06](06-recovery.html): recover, unknown |
| `note` | Save adoption or other host notes. | Only `premise-change` increments topic revision; reassess older replies against the new premise. | [04b](04b-adoption.html): premise, note |

## Programs and helpers

Paths below are relative to the skill root. `lib/` means `scripts/lib/`.

| File | Function | Diagram |
| --- | --- | --- |
| `scripts/review-mail.ps1` | Preserve the original invocation, call a bounded process, wait for cleanup and necessary finalization. | 05a / 05b / 08 |
| `scripts/review-mail.mjs` | Validate JSON and dispatch 12 actions; check tool identities and run settings. | 08 |
| `scripts/invoke-process.ps1`; `lib/ProcessTransport.cs` | Place child processes in a Windows Job; manage deadlines, output, native exit status, and process-tree cleanup receipts. | 08 |
| `lib/reviewer-profile.mjs` | Normalize tool aliases; reject same-tool review; manage defaults, one-time choices, and revision checks. | 08 |
| `lib/acp-route.mjs` | Discover official entries and local candidates; preserve route fingerprints, material controls, and probe evidence. | 02b / 08 |
| `lib/acp-client.mjs` | ACP initialize, authenticate, session/new or load, prompt streaming, cancellation, and stop results. | 05a / 08 |
| `lib/mail-exchange.mjs` | Archive letters, send once, handle status/cancel, correlate replies and process receipts, and finalize. | 05a / 05b / 08 |
| `lib/mail-store.mjs` | Store projects, topics, runs, exchanges, states, notes, revisions, and recovery evidence under short locks. | 08 |
| `lib/mail-contract.mjs`; `lib/safe-files.mjs` | Validate IDs, UTF-8, fields, hashes, ordinary local paths, and private data boundaries. | 08 |
| `lib/windows-lock.mjs`; `lib/build-lock-helper.ps1`; `lib/LockTransaction.cs` | Compile and use atomic short locks so concurrent writers cannot overwrite each other. | 09 |
| `lib/argv-launcher.mjs`; `lib/build-argv-launcher.ps1`; `lib/ArgvLauncher.cs` | When an adapter accepts only an executable, launch the real CLI with explicit arguments and forward streams/exit status. | 09 |
| `tests/run-offline.mjs`; `tests/run-windows.ps1` | Check mechanical contracts and Windows process behavior when requested. These are not evidence of reviewer quality on real tasks. | 09 |
| `scripts/export-clean.ps1` | Export a new clean folder and manifest from an explicit file allowlist; never upload or publish. | 09 |

Individual `.test.mjs` files and `tests/fixtures` supply the two test entry points. They are not extra tools run during every ordinary review. Figure 09 distinguishes `_private`, project records, and public exports.
