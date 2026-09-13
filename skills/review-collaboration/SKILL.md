---
name: review-collaboration
description: Use when the user requests another agent's review or discussion of an idea, plan, artifact, disputed question, or uncertain recommendation.
---

# Review collaboration

Use one external reviewer for each run. The agent in the user's current session is the **host**. This Windows skill preserves letters and process evidence; the host judges the result. It requires an installed, authenticated reviewer with a verified ACP route and a host capable of dispatching a native subagent.

For user-requested skill maintenance, use [improvement proposals](references/verification.md#improvement-proposals) instead of steps 1–4; no reviewer connection is needed.

The host does not need an ACP server: the bundled tool acts as the ACP client. The reviewer needs native ACP or a verified ACP adapter. For a missing adapter, login, or host tool capability, follow [first connection](references/first-connection.md) before sending; keep the draft and the chosen reviewer.

The host prepares the route and any standard ACP authentication call. Use `authenticate` to inspect advertised login methods and invoke a verified choice; the user only completes personal authorization in the agent's official flow. Never ask the user to find or paste credentials. Authentication success alone is not a verified model exchange.

## 1. Trigger and identify

Start when the user requests the collaboration. Identify the actual host tool independently of its model. Obtain its session key from the host runtime; if unavailable generate and record a UUID identified as `generated:`. Restore that key only when resuming the same host session. A different host session opens a new run.

Check for a real native subagent facility. If unavailable, report `subagent-unavailable` / `blocked-host-capability` and stop before sending. A role described in prose is not a subagent. Installing capabilities needs the user's authorization.

Read [mail records and tool calls](references/mail-records.md) for the JSON action contracts. Call `resolve` for this host. With no saved reviewer, ask the user to choose **one** tool; model/thinking may stay provider-default. Reuse a saved selection on later invocations and announce it every time. Example: “Host: Codex; reviewer: Claude; model/thinking: provider defaults; channel: ACP.” Report observed values only when the runtime provides them.

Reject the same host/reviewer tool even if models differ. A one-time selection override leaves the saved preference unchanged; an explicitly permanent change uses `profile-set` with the current revision. If a route is absent, changed or failed, read [first connection](references/first-connection.md). Existing verified routes do not need recurring discovery or an extra model probe.

## 2. Frame and authorize a letter

The **user and host** establish the question and useful outcome. Use relevant project documents, or [short background](templates/background.md) when none exists. Include an existing proposal and its reasons; an exploratory question need not invent a proposal first. Distinguish the user's goal and actual constraints from assumptions or choices open to challenge. The reviewer may question premises, explore alternatives or identify missing evidence; agreement is not a completion requirement.

Look up the project's `.review-collaboration/index.md` and the specifically relevant topic records. Reading local history does not authorize sending it. Continue a topic when the decision/question is the same; otherwise create a topic with explicit related-topic IDs. The same project is readable by different host tools, but separate projects keep separate record roots.

Prepare [a letter](templates/request.md) with the context that could change this judgment: proposal/reasons, applicable conditions, supporting evidence and important unknowns or counterevidence. Keep claims beside their evidence and source version. Reuse a checked explanation or necessary original excerpt across handoffs; avoid repeatedly summarizing a summary. Remaining detail can have a source pointer explaining what it can answer; short relevant material may be cheaper to include upfront. The templates are prompts, not required headings, length limits or response schemas.

Explain the intended reviewer and actual materials to the user; use existing authorization where it covers them. Read [data boundaries](references/data-boundaries.md) for new sources or routes. Specify which checked snapshots and excerpts the subagent may reuse; readable local files are not automatically sendable. New private sources or broader disclosure require authorization. Credentials, account metadata and unrelated conversation history stay local.

Initialize project records if needed; open a run using the chosen topic, host session key and frozen reviewer selection. Preserve the returned IDs. An active run keeps its selection even if the host's saved preference later changes.

## 3. Dispatch the host subagent

The **subagent and reviewer** perform the discussion. Dispatch a real host-native subagent with [the handoff](templates/handoff.md): question, constraints, proposal/reasons, approved snapshots and lookup pointers, record paths/IDs and autonomy limits. Supply sections 3–4 or a readable path, with the skill revision or hash used; retain that procedure for this run. Give the packet without the full host conversation. Keep detailed working notes and correspondence in the delegated work and saved records; bring back decision-relevant results or a necessary host question.

The subagent identifies which judgments the supplied material supports and where an assumption or unknown matters; it cannot prove that omitted context does not exist. It uses the same `review-mail.ps1` entry to submit immutable letters and receive ordinary text replies. ACP carries both directions; the tool saves streamed text and correlated completion evidence, without requiring the reviewer to write files or contact the host separately.

For a gap, first use a relevant authorized source when it can resolve the question. Answer the supported part and retain conditions for the rest. Return a grouped, specific question to the host when a material unknown cannot be resolved within the packet, a user decision is needed, or new source/disclosure authority is required; explain which decision depends on it. A missing clue is not permission to invent context. Follow-up letters carry the necessary change or excerpt; reuse valid prior material instead of recopying all history.

For a consequential claim or proposed change, check the supporting source, reasoning or counterexample. Separate whether an observation holds from whether acting on it is worthwhile. A concrete alternative that could change this choice may be compared within the current question and authority even when the original works. Ask the reviewer for grounds, conditions and impact where needed; do not require a fixed number of findings, a replacement proposal or agreement.

Before another exchange, identify the missing grounds, counterexample or alternative it could add and how that could change the choice. Resolve claims using available evidence; continue when the remaining judgment needs the reviewer's contribution. Otherwise return the supported result and disagreement. Respect the agreed scope and budget; no fixed round count. A changed opinion needs evidence or reasoning.

## 4. Receive and accept

Before returning, the subagent accounts for every question and objection raised in this run that could change the decision, with its disposition and reasons or an explicit unresolved status; duplicates may be merged. Return the resulting conclusions with conditions, evidence key points and precise sources, plus material unknowns or counterevidence. Distinguish verified findings from conditional recommendations. Keep the context needed for adoption in the direct return; link full correspondence and operational details. Surface failures affecting adoption. Pointers supplement explanations; compression preserves claim limits. The host may keep working while its runtime supports a pending call; results stay on disk until read. There is no background terminal notification service.

Before using a reply, inspect `status` and its completion evidence. `reply-ready` confirms receipt integrity, not correctness. With unknown delivery, use `status`/`recover`; do not resend under a new ID to work around uncertainty. Read [mail records](references/mail-records.md) for cancellation, session reconstruction and busy-run recovery.

The **host** checks decision-changing conclusions against the user's current goal, constraints and actual artifact, following their cited evidence where needed. It may accept, partly accept, reject or request a specific clarification. Explain a rejection by its evidence, reasoning or applicability rather than the host's prior preference. Record the decision and reasons with `note` (`adoption`); use `premise-change` when constraints changed during the review and reassess replies before applying them. Communication approval is not permission to edit or publish an artifact.

Retain useful workflow observations already apparent during the task in the adoption note, with evidence and the skill revision used. This adds no separate per-run evaluation or maintenance pass.

End with the selected reviewer, requested/observed settings, conclusion and disagreements, evidence locations, and any remaining limitations. On a fresh or compressed session, reconstruct from the topic index and relevant letters. Original native sessions are an optimization; durable records provide continuity. For validation claims or upgrade/release work, read [verification](references/verification.md).
