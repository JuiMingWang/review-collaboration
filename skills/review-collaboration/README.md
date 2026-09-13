# Review collaboration — Windows ACP mail

Use your current agent as host and one selected external agent as reviewer. The host delegates the review conversation to its own subagent; Markdown letters, snapshots and process receipts stay in local project records. The host accepts or rejects the result. Start with [SKILL.md](SKILL.md).

## Prerequisites

- Windows, PowerShell 5.1, .NET Framework compiler and Node.js. Tested Node: v24.18.0; the ACP SDK does not declare an engines range, so other Node versions need verification.
- A host that can read this skill, call local tools and create a real native subagent.
- An already authenticated reviewer plus a compatible ACP endpoint. An interactive `codex`, `claude`, `pi` or `agy` command alone does not establish an ACP route. A listed adapter is a candidate, not proof of local compatibility.
- Writable ordinary local directories for this folder's `_private` and the project's `.review-collaboration`; NTFS hard-link support. Records cannot be inside the skill package. UNC/reparse paths are rejected.

The folder has all skill-owned sources, templates and tools. Node, Windows and reviewer runtimes remain external prerequisites. Prepare the locked dependencies once with `npm ci --ignore-scripts` in this folder, using an appropriate local npm cache. This is an explicit setup action, not something normal skill invocations download automatically. Package/lockfile pin the dependencies; do not copy authentication files.

Private self-move: copy this entire folder (including needed local dependencies and `_private`) and separately move any project records you want to retain. Private profiles may contain old absolute executable/evidence paths; re-resolve/revalidate on the new machine. This does not promise that a native reviewer session transfers. For public sharing, use the exporter below rather than the private self-move copy.

## Tools

| Tool/module | Job |
|---|---|
| `scripts/review-mail.ps1` | Windows entry: request JSON, bounded process tree, correlated result and finalization |
| `scripts/review-mail.mjs` | Validate and dispatch resolve/probe/profile/project/topic/run/exchange/status/cancel/recover/note actions |
| `mail-store.mjs` / `mail-contract.mjs` | Immutable letters, hashes, revisions, locks and honest completion states |
| `reviewer-profile.mjs` / `acp-route.mjs` | One preference per host, executable fingerprints, material assessment, ACP discovery/probes |
| `acp-client.mjs` / `mail-exchange.mjs` | One ACP connection core, ordinary text both directions, cancel/resume and durable evidence |
| `safe-files.mjs`, `windows-lock.mjs`, `LockTransaction.cs`, `build-lock-helper.ps1` | Local path guards and atomic short lock transactions; generated helper stays in `_private` |
| `invoke-process.ps1` / `ProcessTransport.cs` | Own and clean this invocation's Windows process tree |
| `argv-launcher.mjs`, `build-argv-launcher.ps1`, `ArgvLauncher.cs` | Optional native executable that prepends explicit CLI arguments, forwards bytes and preserves exit status when an adapter accepts only an executable path |
| `export-clean.ps1` | Copy only individually approved public files into a new folder |

All modules above are under `scripts/lib` unless a different path is shown. No global hook or Herdr installation is required. Normal JSON calls are documented in [mail records](references/mail-records.md); first-time routing in [first connection](references/first-connection.md).

For routine use, the host reads this skill and uses `review-mail.ps1 -RequestFile <absolute-envelope.json>`; no output path is required. All automatic operation files stay under this folder's `_private/operations/<UUID>`. They are not the project letters and are excluded from a public export. First-time connection setup is required once per local reviewer route; adding an unknown CLI still requires a compatible adapter and a checked material boundary. The core does not infer them from a successful interactive launch.

## Verify and share

Read [verification](references/verification.md) for what is and is not proven. From this folder, run `node tests/run-offline.mjs --evidence-root <new-absolute-directory>` and `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tests/run-windows.ps1 -Suite All -EvidenceRoot <another-new-directory>`.

To create a public copy, run `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/export-clean.ps1 -SourceRoot <this-folder> -Destination <new-folder>`. It excludes `_private`, node_modules, project letters and local execution evidence. Review the exact exported files before publication. Exporting does not upload anything and a scan cannot prove the absence of every possible secret.

The communication layer does not prescribe scores, consensus, review rounds or automatic code changes. Semantic review-method optimization is separate.
