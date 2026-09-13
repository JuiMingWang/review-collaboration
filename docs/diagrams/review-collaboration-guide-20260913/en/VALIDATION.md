# Diagram verification — R11, 2026-09-13

The bilingual guide contains 12 diagrams per language. All final specifications and HTML artifacts pass Archify 2.17 showcase checks (9/9, zero errors and warnings), and the exact HTML bytes match passing browser receipts. The gallery index is checked separately and is not an Archify diagram.

Browser checks cover Windows Chrome at 1440×900, 1600×1000, 1920×1080, and 2048×1320. The primary assistant inspected light/dark screenshots at the smallest and largest sizes for clipping, overlap, contrast, and route legibility. R11 newly checks all 12 English diagrams and Chinese 04b, 07, 08 (60 final screenshots). For the other nine unchanged Chinese diagrams, matching source, HTML, and screenshot hashes bind the existing R10 inspection evidence (36 screenshots). Public PNGs copy the final 2048×1320 light screenshot exactly.

Early compact English layouts failed readability or routing checks. They were abandoned after bounded repairs; a wider-node layout with adjusted logical ranks passed. Connection routing and recovery labels were then checked on their final renders. Failed candidates remain in private evidence and are not published as passing artifacts.

Automated receipts retain `visualReview: pending`; assistant image inspection is a separate hash-bound record. These checks do not establish review quality, token savings, zero information loss, independent novice comprehension, mobile support, or every browser. This publication makes no new external-reviewer or native-host execution claim. Chinese authored text is translated in the English edition; fixed viewer UI may retain its English fallback.

## Exact artifacts

| File | Bytes | SHA-256 |
| --- | --- | --- |
| 01-overview.workflow.json | 3182 | d5e8f37368bbd70eafe22e996b7cfe1cb03817c94bc47838090fc859f3c9cdd7 |
| 01-overview.html | 708782 | 4c27238a453627de34050fbbf00f16f1f81f49a8a40421a779694db38c89496b |
| 01-overview.png | 159046 | 04729497fc61e101c6710646ee02fcd2425c2e57f5e43b9e4cc887dbbde44e29 |
| 02a-selection.workflow.json | 4035 | eca407106743a289eea7fd9fc9ec43e7e3686677df327d736ac913be5f9499f1 |
| 02a-selection.html | 713645 | b219358340aaa2d4a9cb7949899d1463105436541a1a6d1d74a33bde446cd0bc |
| 02a-selection.png | 176085 | 1e2fb496fdc9d661bc20e6afef01045bf9d698fdcf1ecfcf159a7b5e243ee90e |
| 02b-connection.workflow.json | 4080 | 4ff927cea574805e5107d593a89cadcd4fc23554a5de4d33b4d20d91c7b46908 |
| 02b-connection.html | 712861 | 9d487d792578be92566f1c0c5d8a476f0946eccee74224d41cbb7b1513b9d420 |
| 02b-connection.png | 180192 | 793267f3cb0289bb82cd94d47d331caddfa02fd37e4f5274d1604c3d0b559e50 |
| 03-handoff.workflow.json | 4259 | a3ef926e60e7a50078175109cf047518433141554050b19040403354d987b67a |
| 03-handoff.html | 713553 | 0a3bee381e74ec41a31085eed435df38838189cc60a5da91c4320d14e56b6fa0 |
| 03-handoff.png | 182388 | a6c8cbc8adfa23ea0ed8e94f04593ac0bcc22b07c864d5da76c358b7a3598729 |
| 04a-discussion.workflow.json | 4194 | 022748b3c4842fcd461dfef6a1469423ba99e15223405a83497faf82918d3828 |
| 04a-discussion.html | 714471 | ff3d712968f03913dc858648a92418fd2befadd84f5cdbd3b089cad927f2af60 |
| 04a-discussion.png | 175796 | 2f92e052585e2ca507651f712c6847b2b1a381fb7f2657503b4176d4cb871e70 |
| 04b-adoption.workflow.json | 4314 | 682f5b6d971336b28ccb6542eb6020a70f13081b3319b9057194f733824f7f8b |
| 04b-adoption.html | 714364 | 293bf523a34eab4a8355b9aafd129757c03774ed23aa2799adf752ef7d003b66 |
| 04b-adoption.png | 188220 | 3f0ef963b881c3753a8af69e26e83c50339c3d722f9871041688568f5ddef757 |
| 05a-send.sequence.json | 2630 | d21618d8738cf3eb5d7d882721f5248070216fe065c624c292edc7e476ce2fe0 |
| 05a-send.html | 706700 | 195dc75562bd0c71d492643a86570836438e6f581e2a16f5d5c0200fc5b56932 |
| 05a-send.png | 139188 | 5a71de9d2c3e7fa444459413b26b91b03a110f2c5f0de890e6913ba87f2b916a |
| 05b-finalize.sequence.json | 2610 | 5121bea3548109479d8adcd961d28bf3b5a5adc643e17185e8266848a3132276 |
| 05b-finalize.html | 706357 | 57677149bdfec564fead6bf206f976e8218b04f4371c7a19fafa3f010c507dd4 |
| 05b-finalize.png | 136303 | 1edf6bcfc5385329cd662ae843490695f8864740aa9bfc522aba257de3d22a8f |
| 06-recovery.workflow.json | 4333 | 2f47d93061dd047c4d3941a57aeb1c82f23112463e9f60479a59a3907a1647df |
| 06-recovery.html | 714915 | 04f9cd7d5fb83063e2e9f40eac3a55a6ddbae9f26d6a6513992ecf058f4ad8fa |
| 06-recovery.png | 180918 | 20248b5ab2a31eb202824e16f55f8c1ceba506627fa47ea73961360e2debd658 |
| 07-improvement.workflow.json | 4654 | 0b8769eec474583daffdad83d9c8e53e97aed5bdb2cfc4088c49d39aa4744fe9 |
| 07-improvement.html | 715352 | 83175bea599839d8cca70c338223c645fcf0af92712afff54dbbee2849abf12f |
| 07-improvement.png | 186917 | 01c38c00c03b4fc94670dadd3a6ce922f3084196c14dccaa41f5c0736f8b9d5f |
| 08-programs.architecture.json | 4751 | 6ad5053665d09d10469a6ed28831ebdaab437e2922746e969366b3516adcdcd5 |
| 08-programs.html | 715606 | b8d746b0994804751429e49ea758c1f74ce2c2bb3619e772fe585e86b0998a34 |
| 08-programs.png | 167589 | ed61655e88f579d4648b4cff43b19406fd16201b0ac795878061157d6741e44c |
| 09-support-and-data.architecture.json | 4719 | fef0270747ea8af392a2ca640babad7e4d4ea65cb0e13103db289970f976566e |
| 09-support-and-data.html | 715587 | 4a021e3f4fa754a462102999515cf13b51cc3a0ad715f349829b8ff7c8f6d900 |
| 09-support-and-data.png | 177913 | 4bd2091ef70ab3f415da4832217e971712a02d4eed660dd6d35f363ccf077b67 |

The parent `release-manifest.json` lists every public guide file. Raw browser receipts and private machine paths are excluded.
