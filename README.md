# Review collaboration

[繁體中文](README.zh-TW.md) · [Visual guide](docs/diagrams/review-collaboration-guide-20260913/en/README.md) · [Skill entry](skills/review-collaboration/SKILL.md)

Ask an external AI reviewer to examine an idea, plan, artifact, or disputed question while keeping the host agent's context focused. A native subagent handles the detailed discussion, verifies consequential claims, and returns conclusions with reasons, evidence, conditions, and unresolved disagreements. The host decides what to adopt.

This is a **Windows agent skill with an ACP communication helper**. It preserves Markdown correspondence and delivery evidence in local project records. It does not require consensus, prescribe a fixed number of rounds, or automatically change your work.

[![Overview: user, host, native subagent, and external reviewer](docs/diagrams/review-collaboration-guide-20260913/en/01-overview.png)](docs/diagrams/review-collaboration-guide-20260913/en/01-overview.html)

The README embeds a static preview. GitHub displays HTML source rather than running it: clone or download the repository, then open [the English gallery](docs/diagrams/review-collaboration-guide-20260913/en/index.html) or [the Chinese gallery](docs/diagrams/review-collaboration-guide-20260913/index.html) locally. Each diagram supports zoom, search, and light/dark themes. There are 12 diagrams in each language, covering setup, review, recovery, maintenance, and program functions.

## When to use it

- Challenge assumptions or compare a concrete alternative before choosing a plan.
- Review an artifact or recommendation against its actual evidence and constraints.
- Explore an unfinished idea without inventing a proposal or forcing agreement.

The workflow needs a host with real native subagents and one external reviewer using a different agent tool. Changing only the model does not count as a different tool.

## Requirements

| Requirement | What it means |
| --- | --- |
| Windows tooling | PowerShell 5.1, the .NET Framework compiler, and Node.js. Node v24.18.0 is the tested baseline; other versions need verification. |
| Host agent | Can read the skill, execute local tools, and dispatch a genuine native subagent. The host does **not** need an ACP server. |
| External reviewer | Installed agent runtime, usable authentication, and native ACP or a verified compatible ACP adapter. An ordinary CLI that launches successfully is insufficient. |
| ACP route | The bundled client must verify the selected endpoint, versions, configuration, and permitted material/tool access. Discovery, handshake, authentication, and a real reply are separate evidence levels. |
| Local storage | Writable ordinary local directories with NTFS hard-link support. UNC and reparse paths are rejected. Project records must be outside the skill package. |
| Model access | Your chosen reviewer's own account/API setup and applicable usage charges. No credentials or paid access are included. |

ACP means Agent Client Protocol: the helper acts as its client and sends and receives review text over the same connection. Reviewer-specific installation and authorization happen through the agent's official flow. No global hooks, Herdr, or agency-agents package is required. Archify is only needed to regenerate diagrams, not to use the skill or view the supplied HTML.

## Set up

Clone this repository into an ordinary local folder, then prepare the locked dependencies:

```powershell
git clone https://github.com/JuiMingWang/review-collaboration.git
Set-Location .\review-collaboration\skills\review-collaboration
npm.cmd ci --ignore-scripts
```

The complete skill folder is **`skills/review-collaboration/`**, not the repository root. Register that folder through your host's skill mechanism, or explicitly ask the host to read its `SKILL.md` at the cloned path. If your host requires a copy in its skill directory, copy this whole folder and prepare dependencies there. Do not overwrite an existing installation or carry over someone else's private profile.

Have the host follow [first connection](skills/review-collaboration/references/first-connection.md) for the chosen reviewer. It checks the actual route, inspects supported authentication when needed, and distinguishes handshake proof from an authorized synthetic reply. Valid saved routes are reused; normal invocations do not download adapters or repeat model probes. Missing prerequisites stop sending and preserve the draft.

For this repository's older root-level v1 installation, retain the old installation and records separately while finishing active work. This publication does not include an automatic v1 state migration. Earlier files remain in Git history.

## Start a review

For example, tell your host:

> Read `skills/review-collaboration/SKILL.md` and use it to review this plan. Compare my proposal with any alternative that could materially change the decision. Use the attached plan and these named source files as the permitted review material.

If no reviewer preference exists, the host asks for one reviewer. It announces the reviewer and requested/observed settings, explains the material being sent, and reuses authorization already given.

1. **Host prepares:** frame the question, include a proposal and reasons when available, supply decision-changing background, and define read/send boundaries.
2. **Native subagent discusses:** send the letter, check relevant authorized sources, and compare grounded alternatives. Continue only when the missing contribution could affect the decision; group necessary questions to the host.
3. **Subagent reports:** account for every material question or objection with reasons or an explicit unresolved status. Preserve evidence, conditions, and disagreement; full correspondence stays in records.
4. **Host decides:** verify completion and consequential findings, accept/partly accept/reject, and record the decision. `reply-ready` proves receipt completeness, not correctness or adoption.

## Tools and files

| Tool or module | Purpose |
| --- | --- |
| `scripts/review-mail.ps1` | Windows JSON entry; owns the bounded invocation, process cleanup, and finalization. |
| `scripts/review-mail.mjs` | Validates requests and dispatches the 12 actions below. |
| `reviewer-profile.mjs` / `acp-route.mjs` | Reviewer selection, revision conflicts, route identity, discovery, and connection evidence. |
| `acp-client.mjs` / `mail-exchange.mjs` | ACP handshake/authentication/session text, single-send correspondence, cancellation, and reply evidence. |
| `mail-store.mjs` / `mail-contract.mjs` / `safe-files.mjs` | Project/topic/run records, immutable letters, IDs, hashes, and local path checks. |
| `invoke-process.ps1` / `ProcessTransport.cs` | Windows process deadlines and cleanup of the invocation's process tree. |
| `windows-lock.mjs` and lock helper | Atomic short transactions that prevent concurrent record overwrites. |
| `argv-launcher.mjs` and launcher helper | Optional bridge when an adapter accepts an executable path but cannot supply the required CLI arguments. |
| `tests/run-offline.mjs` / `tests/run-windows.ps1` | Reproducible communication and Windows behavior checks; no proof of review quality. |
| `scripts/export-clean.ps1` | Exports 48 allowlisted source files plus a hash manifest; does not publish them. |

Paths are relative to the skill folder; unqualified modules are under `scripts/lib/` and `invoke-process.ps1` is under `scripts/`.

| Actions | Purpose |
| --- | --- |
| `resolve`, `profile-set` | Read the saved choice or explicitly change its default. |
| `authenticate`, `probe` | Inspect/invoke authentication; verify a handshake or an authorized synthetic exchange. |
| `project-init`, `topic-create`, `run-open` | Create local records and freeze the current run's reviewer, route, settings, and deadline. |
| `exchange` | Archive and send one authorized letter; repeated calls inspect the same exchange without resending. |
| `status`, `cancel`, `recover` | Inspect evidence, request cancellation, or finalize correlated original results. Unknown delivery remains unknown without proof. |
| `note` | Save adoption and other host notes; a premise change increments the topic revision. |

See the [complete tool map](docs/diagrams/review-collaboration-guide-20260913/en/TOOLS.md) and [JSON contracts](skills/review-collaboration/references/mail-records.md). The agent constructs the request; users do not need to handwrite an envelope for an ordinary review.

## Records, privacy, and improvement

Project letters and adoption notes live in the project's `.review-collaboration/`. Local routes, preferences, compiled helpers, and operation receipts live in the installed skill's `_private/`. Keep both private, along with credentials and `node_modules`. Local read access does not authorize sending a file to the reviewer, and a separate working directory is not read isolation. See [data boundaries](skills/review-collaboration/references/data-boundaries.md).

Ordinary use saves useful observations already seen; it does not run a separate evaluation after each review. When you request maintenance, the agent consolidates relevant evidence into concrete keep/delete/merge/rewrite/add proposals. You decide which to adopt as a batch. Attribution first checks whether the relevant information was obtainable at the time and could have changed the decision. The skill does not rewrite itself in the background or guarantee continuous improvement.

## Verification and version

This publication is **R11 (2026-09-13)**. The helper's package version remains `0.1.0`; R11 identifies the documented source snapshot, not an npm release. Relative to R10, procedural changes clarify material-issue coverage and attribution during maintenance. Transport behavior and dependency pins are unchanged.

The supplied suites and their commands are documented in the [package README](skills/review-collaboration/README.md#verify-and-share). Read [verification levels and limits](skills/review-collaboration/references/verification.md) before making compatibility claims. Diagram checks are recorded separately in [VALIDATION.md](docs/diagrams/review-collaboration-guide-20260913/en/VALIDATION.md); they do not establish lower token cost, zero information loss, or reliable judgment on every task.

## License

[MIT](LICENSE). Generated diagram viewers include the separately preserved [Archify license](docs/diagrams/review-collaboration-guide-20260913/ARCHIFY-LICENSE.txt).
