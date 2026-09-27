# Sources and coverage

[繁體中文](../SOURCE-MAP.md) · [Reading guide](README.md)

The source baseline is R13. Paths below are relative to the skill root. The diagrams are authored explanations, not additional actions or review rules. Unlabelled arrows only omit sequence already explicit in their endpoints; authorization and consequential branch conditions remain labelled.

| Figure | Primary sources | Coverage |
| --- | --- | --- |
| 01 | SKILL.md | Roles, bounded delegation, concise evidence-bearing return, host adoption. |
| 02a | SKILL.md; scripts/lib/reviewer-profile.mjs; scripts/lib/acp-route.mjs | Native host capability, tool identity, saved/one-time choice, revalidation, and new sessions. |
| 02b | references/first-connection.md; references/data-boundaries.md; scripts/review-mail.mjs | Endpoint and material checks; zero-prompt handshake/authentication; authorized live probe; stop on missing prerequisites. |
| 03 | SKILL.md sections 2–3; templates/background.md; templates/request.md; templates/handoff.md | Decision-changing context, read/send authority (including same-topic follow-ups), IDs, procedure revision, round cap, and handoff. |
| 04a | SKILL.md section 3; templates/handoff.md | Source checks, grounded alternatives, host questions; unsettled points go back with reasons until settled or the round cap is reached. |
| 04b | SKILL.md section 4; references/mail-records.md; scripts/lib/mail-store.mjs | Every material point has a settlement state and both sides' reasons; rejections the reviewer still holds go back within the cap; conditions, premise revision, reasons, and observations remain. |
| 05a | scripts/review-mail.ps1; scripts/review-mail.mjs; scripts/lib/mail-exchange.mjs; scripts/lib/acp-client.mjs | Steps 1–6: unique invocation, immutable archive, unknown delivery before prompt, same-connection reply. |
| 05b | scripts/invoke-process.ps1; scripts/lib/ProcessTransport.cs; scripts/lib/mail-exchange.mjs; scripts/lib/mail-store.mjs | Steps 7–12: outer cleanup, bounded finalization, correlation, completion, and reply-ready. |
| 06 | references/mail-records.md; scripts/review-mail.mjs; scripts/lib/mail-exchange.mjs; scripts/lib/mail-store.mjs | Status/recover/cancel send no prompt; busy/unknown states, no blind resend, explicit context reconstruction. |
| 07 | references/verification.md: Improvement proposals | User-requested maintenance, obtainable and decision-relevant information before attribution, concrete options, batch decision, base check, stop. |
| 08 | scripts/review-mail.ps1; scripts/review-mail.mjs; scripts/lib/ | Main module responsibilities and dependencies, not every import or function call. |
| 09 | README.md; scripts/export-clean.ps1; scripts/lib/windows-lock.mjs; scripts/lib/argv-launcher.mjs; tests/ | Data locations, 48 source files, supporting tools, tests, and external prerequisites. |

## Qualifications behind simplified paths

- Figure 02b shows one valid setup order. Authentication inspection requires a verified endpoint and access authorization, but does not itself require a completed model-material assessment or produce live proof. Material control must be checked before sending model material.
- Missing setup prerequisites stop sending. The shared failure node and cards cover these cases without repeating a failure arrow from every node. A still-valid route goes directly through 02a.
- A follow-up in 04a explicitly returns to step 1. Host-supplied context returns to verification. Follow-ups continue until every consequential point is settled (agreed, resolved by evidence, or reasoned disagreement after both final positions) or the round cap is reached (default 4 follow-ups); points the host or subagent rejects go back to the reviewer with reasons. The diagram draws one stop line for the round cap; stopping for a user decision or new material is shown by the unresolved-gap node.
- 05a/05b show the normal exchange only. Figure 06 handles non-normal stops and unknown delivery; missing evidence cannot be replaced with an invented normal result.
- Figure 08 shows main responsibilities. The entry coordinates recover through mail-store and any needed finalization; mail-exchange is not the sole recovery implementation. Other modules also use shared checks.
- Tests, export, and the optional argument launcher are used when needed. Package location does not prove host registration or reviewer connectivity. Private state is not part of the public share.
- Later outcomes may support, refute, or leave an improvement uncertain. A rollback is still a proposal requiring adoption; absence of feedback is not success.

## Exact source bytes

Compare these hashes with any relocated copy of the skill. Code identifiers and node IDs remain unchanged between language versions.

| File relative to skill root | SHA-256 |
| --- | --- |
| README.md | 75b5179311dab651f212f0b4c31a8d5f4d280401d2ae126c6198995d5752dc1a |
| SKILL.md | 2da33f1a8388ed76da80b93e52309c6cbf101d464aedc687f29ce7b8f6d165c5 |
| references/data-boundaries.md | bcabc0a16093206eb7b3a9b987f28478435144ad3593f5eaae7dfe127f313fc6 |
| references/first-connection.md | bd379aaa98ff9d01551fd1efdcec7f5f5fcf9bd3b40cad40ed18f9a3f918c24a |
| references/mail-records.md | 2d95953758c80f1ae8cc892a6e6f6612f367ea19350073f1de780df3f72c319f |
| references/verification.md | c0e65b7953518b05163ffe81c0e92af4f8dfce375d74c23c6d8a21a3ec987e3f |
| scripts/export-clean.ps1 | 34a9033ac0ec75b65e69b15e8643d2bfacd1cac704154985dc69ba7855ce7e6c |
| scripts/invoke-process.ps1 | 2c78a98dea6a2212bde41eea6a6eef60c91a79976f4e92f7d41c86205502a4ac |
| scripts/lib/ArgvLauncher.cs | 4b1ad33f17f062827d48e142fd034e285c1dc7d4bcb399c226554ab6e8f161aa |
| scripts/lib/LockTransaction.cs | adf6852edf9092b1eaf56484232bae216b91117ce58aaa1cedaad97c7dad090e |
| scripts/lib/ProcessTransport.cs | 7166ff0322a2e8ab566f5e1543b3ed21c10af7101fc524527d2ce45434cd1d38 |
| scripts/lib/acp-client.mjs | c4d49624979c64a0e8d210e4bc705ef6405ac07349d8eca4b7a182f5391d9baf |
| scripts/lib/acp-route.mjs | 442dea258cfaa53f804eb2a3baa9b4fdb6b44816e14dc02dd611f23ed98037e3 |
| scripts/lib/argv-launcher.mjs | 5ed5fe429b15b3cdc74b0b755704a9c512ac01f7b0926aac94a09c69792b0e97 |
| scripts/lib/build-argv-launcher.ps1 | e3e98de837489e53e7e1eaf891e45b081ee25cd8010da8cb1d385daa7d2feefa |
| scripts/lib/build-lock-helper.ps1 | c036deed2a94f4bdc340a375ec997ef281a0e7c8375d5ef9bed22a3f8adf5445 |
| scripts/lib/mail-contract.mjs | 0de8ded0e752486dcd9a7f9e1a716ee669fe168df8ba095ab144030f9f5ec1ac |
| scripts/lib/mail-exchange.mjs | 9f9035986d7827fbb4f87f2859b1c948ddc37ce72d5f13675fd406a97763db93 |
| scripts/lib/mail-store.mjs | a70f6af4dac64f45c616d66027c97410f7042698ade0aebe7b78042c49e6ada5 |
| scripts/lib/reviewer-profile.mjs | 84d088e3a9a6d3c2092f401066d9a13b88daa1dac6a984a978d14ecffbfbe670 |
| scripts/lib/safe-files.mjs | 3dde4bbc837fcc58f64d0093a326d4b04157077e5e652969e2deb83c32bac763 |
| scripts/lib/windows-lock.mjs | b9246c6a2af1f455bdb241d5f53bd9be7fb572253bd455e7fc63349c5b7d489d |
| scripts/review-mail.mjs | 5fda9fce92bbc6f054ddd1eb17a7fa9a7cfd5e00b0a4917999540c8cd4639da1 |
| scripts/review-mail.ps1 | f2c319af121c6bf04d68389de400632179631b65ce521fddfa852f14e0723e8d |
| templates/background.md | 87735682b70a96ff21e7bfa162123aace3ec8b11dc6ebc6ab9e84f2f4d57d293 |
| templates/handoff.md | fee1e25cd377d70672f282ae2a49489e2821b261506d516856a724c6e372c352 |
| templates/request.md | 182ffcabe96721cb38f482b7075c2d2ead25a80ff2c07fd72e5fd4a4cf51ac26 |
