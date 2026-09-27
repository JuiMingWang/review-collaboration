# Diagram verification — R13, 2026-09-28

The bilingual guide contains 12 diagrams per language. All final specifications and HTML artifacts pass Archify 2.17 showcase checks (9/9, zero errors and warnings), and the exact HTML bytes match passing browser receipts. The gallery index is checked separately and is not an Archify diagram.

Browser checks cover Windows Chrome at 1440×900, 1600×1000, 1920×1080, and 2048×1320. The primary assistant inspected light/dark screenshots at the smallest and largest sizes for clipping, overlap, contrast, and route legibility. R11 newly checks all 12 English diagrams and Chinese 04b, 07, 08 (60 final screenshots). For the other nine unchanged Chinese diagrams, matching source, HTML, and screenshot hashes bind the existing R10 inspection evidence (36 screenshots). Public PNGs copy the final 2048×1320 light screenshot exactly.

Early compact English layouts failed readability or routing checks. They were abandoned after bounded repairs; a wider-node layout with adjusted logical ranks passed. Connection routing and recovery labels were then checked on their final renders. Failed candidates remain in private evidence and are not published as passing artifacts.

Automated receipts retain `visualReview: pending`; assistant image inspection is a separate hash-bound record. These checks do not establish review quality, token savings, zero information loss, independent novice comprehension, mobile support, or every browser. This publication makes no new external-reviewer or native-host execution claim. Chinese authored text is translated in the English edition; fixed viewer UI may retain its English fallback.

R12 redraws 03, 04a, and 04b in both languages (6 diagrams) to show settling each point, sending rejections back, and the round cap. The other nine diagrams per language keep their source, HTML, and PNG unchanged, with the R11 evidence above. The redraw used a later local build of Archify 2.17.0-dev.1: re-rendering the unmodified 04a source produced byte-identical SVG, while the viewer now embeds its fonts instead of loading them from the network, so these six HTML files are larger. All six pass showcase checks (9/9, zero errors and warnings) and visual-check containment at all four sizes, and their HTML bytes match the passing receipts. The primary assistant inspected light and dark screenshots; 04a received endpoint-side and channel pins to avoid shared or detoured routes. Public PNGs still copy the 2048×1320 light screenshot exactly.

R13 re-renders the remaining 18 diagrams (01, 02a, 02b, 05a, 05b, 06, 07, 08, and 09 in each language) with the same Archify 2.17.0-dev.1 build; their JSON sources are unchanged. The re-rendered SVG is byte-identical; only the viewer changes, embedding its fonts instead of loading them from the network, so the HTML files are larger. All 18 pass showcase checks (9/9, zero errors and warnings) and visual-check containment at all four sizes, and their HTML bytes match the passing receipts. The primary assistant spot-checked three light and dark screenshots. Public PNGs copy the 2048×1320 light screenshot exactly. All 24 diagrams now use the same viewer build.

## Exact artifacts

| File | Bytes | SHA-256 |
| --- | --- | --- |
| 01-overview.workflow.json | 3182 | d5e8f37368bbd70eafe22e996b7cfe1cb03817c94bc47838090fc859f3c9cdd7 |
| 01-overview.html | 805375 | 04b5fe62d21a8e72ee744151b46a47f90cf8809e46b4eff8d70f66ced83e03a2 |
| 01-overview.png | 158933 | 9c074964e35d84b13c6164fa33280f07963c00d044ab97cf56cae49a83e97e1c |
| 02a-selection.workflow.json | 4035 | eca407106743a289eea7fd9fc9ec43e7e3686677df327d736ac913be5f9499f1 |
| 02a-selection.html | 810238 | abbfd57d319784ff8196abb1d92e43c0c21ed83a23eaa86cc3745cdfb8c429b7 |
| 02a-selection.png | 176099 | df48147bf7f8ca6313aa60301aba99aeef9cd19f887b2849fb00c3c1622b87b1 |
| 02b-connection.workflow.json | 4080 | 4ff927cea574805e5107d593a89cadcd4fc23554a5de4d33b4d20d91c7b46908 |
| 02b-connection.html | 809454 | 60f782fc139ac7a87850357e36aabd1a23c5072fd56e82802028cf2bd1d18c10 |
| 02b-connection.png | 180048 | cfffbd27473c06934f6b264f0c7be7eeab34390f7a5d37fecb47ced8a4725a06 |
| 03-handoff.workflow.json | 4266 | 460751e0f67ef0814bbe0b1b3be3f6e44d8d16be4cc05d453cbf085941315edd |
| 03-handoff.html | 810174 | 9dbc32e5fc9364eebd05ddb893ee5ac13871afbc9633568a1f74222117397c50 |
| 03-handoff.png | 182457 | edb174bd268da99b42ba0ed1acd27c94cb1b7b6dcc342402e16b523b9011d3c5 |
| 04a-discussion.workflow.json | 4430 | 74d90776417c4eb1a7119672c6d67851d7b35fe99d96259d607fcb47911a18d0 |
| 04a-discussion.html | 811879 | 6144af6b425676e0575f30f9508a8198d089f25ab6b13e735fd4227908c47ed4 |
| 04a-discussion.png | 177928 | dfc424864fd1fdf4ffe90346c2ac88773f10a5abe73fd8cdf419b5b3c21f92c7 |
| 04b-adoption.workflow.json | 4371 | b32e21b32aad29631504d7c23f7f7a1592d2caaa29518d3e6c574a42964492e4 |
| 04b-adoption.html | 811089 | 5fa28e42ed4c0fc345ea3cda9493a84dd746aa254773c746a9650dce7e07daf5 |
| 04b-adoption.png | 189568 | 62401a2a35883836780f435d81b2eaa97fdf4ccc35b4f645368a8e6036ee44c5 |
| 05a-send.sequence.json | 2630 | d21618d8738cf3eb5d7d882721f5248070216fe065c624c292edc7e476ce2fe0 |
| 05a-send.html | 803293 | a75a124a7956a7aeccd66077f1a78a8d07e4810db6815254716e70dd8b13ae10 |
| 05a-send.png | 139128 | 5e0fde8b7851c1efc76b1506957d6a2921a745d0d1fa50c0e2ecc4ab0175bd5b |
| 05b-finalize.sequence.json | 2610 | 5121bea3548109479d8adcd961d28bf3b5a5adc643e17185e8266848a3132276 |
| 05b-finalize.html | 802950 | 79f2ee8179afe93f5bb41241395e6f8ef2911d5e01aa12828fc7be5196cdd2e4 |
| 05b-finalize.png | 136240 | 322863f578ce06885bbc0e5fa616136ec3e0e9818e5cb8ac539b5d4fb6d35a03 |
| 06-recovery.workflow.json | 4333 | 2f47d93061dd047c4d3941a57aeb1c82f23112463e9f60479a59a3907a1647df |
| 06-recovery.html | 811508 | b7211beec0a13399f5053df9b78f446594933b113fcf89e7bb3045890ffedfe9 |
| 06-recovery.png | 181150 | 5a481c066987c958e2d1fd3b098781a1604f1bb7af84c61eaab7e850568a7363 |
| 07-improvement.workflow.json | 4654 | 0b8769eec474583daffdad83d9c8e53e97aed5bdb2cfc4088c49d39aa4744fe9 |
| 07-improvement.html | 811945 | 122c48a7181243f32179261aa0d3e28a8a4f8511cd23d101b1cf8b24549c615e |
| 07-improvement.png | 186939 | cdb0731bdcc9ff0f03928681a98d1a132e9da3f21cdadabee918f1b224cbbdff |
| 08-programs.architecture.json | 4751 | 6ad5053665d09d10469a6ed28831ebdaab437e2922746e969366b3516adcdcd5 |
| 08-programs.html | 812199 | d439aa7b6a14b4c741ad124e9e6fabbcce802a98e735ed2e2eab7ffb2d106468 |
| 08-programs.png | 167475 | 175d62ac9c1c7d9ff8d0854e59bc69b51e21473e593e120333bee9ed1dda9218 |
| 09-support-and-data.architecture.json | 4719 | fef0270747ea8af392a2ca640babad7e4d4ea65cb0e13103db289970f976566e |
| 09-support-and-data.html | 812180 | 6e208399483f1f6801c8d7a507cb55ddefc27ccafedc61828a62007c0d205b3f |
| 09-support-and-data.png | 177779 | 9f967121576821a7e20379592c88dccc9a99ffd6f483f18501315eb1be450f87 |

The parent `release-manifest.json` lists every public guide file. Raw browser receipts and private machine paths are excluded.
