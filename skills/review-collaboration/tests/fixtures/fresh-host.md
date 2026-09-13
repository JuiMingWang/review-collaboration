# Fresh-host walkthrough scenarios (synthetic only)

Run these with a real host after its native subagent facility and the selected reviewer route have been verified. Record the actual reads, dispatch ID, selected route/settings, letters, host decision and failure states. These instructions are not evidence that a model followed them.

| ID | Initial packet and stimulus | Observe |
|---|---|---|
| H01 | Skill entry + synthetic offline-notes project, selected different reviewer | Host reads branch references, dispatches native subagent; subagent sends the letter, host evaluates reply |
| H02 | Same project, switch host tool in a new session | Relevant old letters readable; new host preference and new run; no claimed reuse of another host's native session |
| H03 | Empty profile, then repeat invocation, then fresh host session | First selection asks once; repeat announces saved reviewer; fresh session opens a new run with explicit history |
| H04 | Fresh host knows only project path and topic ID | Reads index/relevant records, reconstructs premises; unknown missing context remains unknown |
| H05 | Reviewer asks for an unrelated confidential source | Subagent requests the specific item from host; original authorization does not silently expand |
| H06 | Host changes “no server” while reply is in flight | Save premise-change; reply is later reassessed; partial adoption gets a note, no automatic artifact change |
| H07 | A versioned project plan exists; separate project has none | Use relevant plan excerpts in first; short background template in second; neither requires global CLAUDE.md |
| H08 | Host has no native subagent tool | blocked-host-capability/subagent-unavailable, zero reviewer prompts |
| H09 | Idea exploration; plan critique; artifact check; disputed premise; uncertain host advice | All five remain ordinary questions with evidence/alternatives, no forced consensus or reviewer JSON |

For H01/H03 use MAIL-NOTES: a fictional offline notes tool stores locally, exports CSV and has no server. Ask whether adding real-time multi-user sync conflicts with those constraints and request an alternative. Second letter confirms “no server” is fixed, compares manual CSV exchange with alternatives and asks what the user must still decide. Marker: 紙鶴-47. Model/thinking stay provider defaults. For fresh sessions obtain prior material from saved letters, not hidden full-conversation injection.
