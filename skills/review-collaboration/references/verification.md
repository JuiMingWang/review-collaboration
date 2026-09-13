# Verification and support claims

These levels are different:

| Level | Evidence |
|---|---|
| discovered | Named upstream entry and pinned local launch candidate |
| initialized | ACP handshake completed, zero prompts |
| authenticated | Explicit advertised agent-method authenticate completed, zero sessions/prompts; not a route verification level |
| offline-verified | Synthetic endpoint contracts pass; no real model implied |
| live-route-verified | Actual pinned reviewer receives authorized synthetic input and produces a correlated saved reply |
| live-workflow-verified | Actual host reads skill, dispatches its native subagent, receives the external review and accepts it |
| release-accepted | A named source/export manifest is bound to the stated acceptance evidence |

Do not equate a process exit, an idle pane or a completed transport with review quality. Test defaults without setters; keep requested/observed values separate. Test two directions separately: Codex-host → Claude-reviewer is not Claude-host → Codex-reviewer. A handwritten JSON-RPC fixture tests the common wire contract, not a real agent's login, defaults or subagent facility.

A controlled test can call two real ACP endpoints and relay A's proposal to B, then B's reply to A. This proves the tested exchange of model messages; it does not prove that either native host UI invoked the skill or dispatched a subagent. Preserve original letters, the exact authorized excerpts, hashes and per-turn receipts. Adapter startup messages may appear as ordinary text chunks: inspect before forwarding, and keep local paths or account notices out of the next letter. Marker delimiters used by a test harness are not a required reviewer response format or part of ACP.

Include a launchable ordinary CLI that does not speak ACP and a missing executable as negative cases: neither may receive the discussion prompt or trigger an automatic fallback. An unlisted fictional ACP endpoint tests whether the common client depends on a brand; it cannot certify every future ACP version or adapter. A host without an ACP server uses the bundled client tool, subject to the separate host tool/subagent requirements.

The package provides bounded offline/Windows suites and fresh-host scenarios. Their reports state coverage and not-run cases. Run from a new evidence directory; preserve native exit, raw receipt, source hashes and cleanup. A runner infrastructure error is a failure, not a zero-test pass. A fault injection proves only the injected condition. Use a fresh copy for mutations; preserve original source/evidence.

For each real route, first assess startup rules/hooks/extensions, authentication reuse, tool access and data scope against pinned implementation evidence. A synthetic prompt or clean cwd alone is insufficient. Do not copy credentials to make a route pass. Unsupported material control is `blocked-material-control`; no native host subagent is `blocked-host-capability`.

Revalidate when executable/entry/version/arguments/configuration mapping changes, required capabilities disappear or a call fails. A saved preference is not a new live test. Reports must name actual runtime versions, route fingerprints, model/thinking observations, and per-direction pass/blocked/not-run results. Registry lookup does not certify availability.

Move the public folder to an unrelated path containing spaces, Chinese and brackets. Prepare locked dependencies and run offline/Windows suites from another cwd; live smokes require the same material gate. Hash every exported file and inspect the exact manifest, not merely the source tree. Published files exclude account data, local routes, private materials and test-run logs. Manual review complements the bounded scan.

Current source includes Windows mechanical tests only as an intrinsic, reproducible package claim. Actual release and live-route acceptance are reported with the specific distributed revision; no assertion here certifies all four local agents, non-Windows environments, sudden power loss, hostile concurrent path replacement or every dependency's behavior.

## Improvement proposals

Read this section only when the user requests skill maintenance. The agent then consolidates actual usage evidence and proposals automatically; ordinary reviews do not start this pass. Existing adoption notes supply observations without a new evaluation round. No additional reviewer or model experiment is required.

Optimize for supported judgments, preserved conditions and usable host handoffs while reducing unnecessary reading, exchanges and instruction load. Shorter text, agreement or an uneventful run alone does not establish improvement.

1. **Select evidence.** Start from the current observation and relevant adoption notes in the chosen project's records. Retain the outcome, decision or cost affected, source pointers, conditions and skill revision used. User corrections and effective simplifications count alongside failures. Read relevant records, not all project history; use additional projects only within their authorized scope. If no actionable evidence exists, leave the procedure unchanged.
2. **Locate the cause.** Separate missing task context, tool faults and local user choices from ambiguous, duplicate, obsolete or excessive skill instructions. Before attributing a bad outcome to a review gap, establish that the relevant information was obtainable at the time and could plausibly have changed that decision; otherwise record changed conditions or uncertain attribution. A model error alone does not prove a missing rule, nor does successful use justify removing an unexercised protection.
3. **Prepare one consolidated proposal.** Compare leaving the skill unchanged with deletion, merging, rewriting, conditional reference placement or addition. Show the affected text, concrete replacement or deletion, supporting evidence, expected behavior, applicability and tradeoff. Prefer editing the existing responsibility; additions explain why existing guidance is insufficient. Consider the main text, templates and references actually loaded together; moving text is not automatically a saving. No fixed rule, word or finding quota.
4. **Keep proposals discoverable.** Only when a proposal exists, use `<record-root>/skill-improvements.md` as a compact local proposal/decision ledger, separate from tool-managed indexes and state. Keep actionable items easy to find; merge duplicate proposals and link original adoption evidence. Record the user's acceptance, deferral or rejection and reason; revisit declined proposals only with new grounds. Resolved detail can stay in linked records rather than growing the active list. This ledger and raw case material stay outside the public skill; ordinary reviews do not load it unless relevant.
5. **Wait for the user's batch decision.** Observations and drafts are not authorization to change the skill, even for reversible edits. After approval, the host rechecks the current source against the proposed base, preserves the old version and exact diff, and applies only the adopted changes. If intervening edits alter the proposal's meaning, revise it before applying. Active reviews keep their supplied procedure; the new version applies to later uses. Installation and publication retain their own scope. The subagent and reviewer supply evidence, not direct skill edits.
6. **Use later real outcomes at the next requested maintenance pass.** Record whether available outcomes support the intended change, remain inconclusive or reveal a regression. Distinguish host-context burden from total usage; unavailable measurements remain unknown. New adverse evidence can support a smaller change or rollback proposal, subject to the same adoption decision. Absence of feedback is not success. Read relevant entries rather than accumulating the learning history in normal context.

**Stop this maintenance pass** once each selected observation has an evidence-based disposition, duplicate proposals are merged, concrete diffs are ready for the user's batch decision, and remaining uncertainty is stated. An approved update ends after its scoped diff, references and version records are checked. Further plausible improvements alone do not reopen it; resume for new actual evidence or a user-requested change of scope. No open-ended search for a smaller or better skill.

This is an agent-executed proposal workflow, not a background updater or model-weight training. It depends on accessible records, honest attribution and later outcomes; it cannot guarantee monotonic improvement or discover facts absent from available evidence. Keep private observations local and generalize only material authorized for the destination.
