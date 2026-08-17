# review-collaboration 的 Step 3-4（跟 codex 協商的迴圈）改用委派給獨立 subagent 執行

**Status**: accepted（2026-08-12）

## 背景

使用者要求評估 `review-collaboration` 本身的機制是否過度占用主 agent（Claude）的 context window，以及把協商過程 fork 出去執行會不會犧牲討論品質。研究過程見 `docs/context_engineering_research.md`（使用者提供）與同一天稍早 `codex-peer-review` 改用官方 `context: fork` 機制的先例（見該 skill 自己的 `SKILL.md` 與 `docs/review-log.md` 的 2026-08-12 條目）。

`review-collaboration` 跟 `codex-peer-review` 的差異：`codex-peer-review` 整個流程都不需要對話存取權（審查的是硬碟上已存在的檔案），所以可以直接用 skill 層級的 `context: fork` frontmatter 把整個 skill 隔離出去。`review-collaboration` 不同——Step 0-2（辨識主題、二元查證、草擬摘要與清單）本質上需要「當下對話」才能做，Step 5（最終報告、使用者確認、動手寫檔案）需要使用者當場互動，這兩段沒辦法委派出去；只有 Step 3-4（跟 codex 來回協商）在 Step 1-2 完成後就是自包含的，不再需要對話存取權，也是實測會累積最多 context 的部分。

## 決定

只委派 Step 3-4，不是整個 skill：
- `review-collaboration` 自己的 `SKILL.md` frontmatter **不加** `context: fork`（因為 Step 0-2/5 需要對話存取權）。
- Step 2 使用者確認清單後，主線把所有 Step 3-4 需要的材料寫成單一 manifest 檔案（`$Dir\manifest.json`），透過 `Agent` 工具派一個 subagent 去執行 Step 3-4（含既有的三項派送檢查：來源稽核／盲測比對／輪數上限），subagent 只回傳精簡結果（共識包 / 未達共識包 / 等待補件通知）三選一，不回傳逐輪原始對話。
- `docs/review-log.md` 只由主線寫，subagent 只在自己的 `$Dir` 裡留工作痕跡，避免兩邊搶寫同一份追蹤檔案。
- 派送前檢查 `CLAUDE_CODE_FORK_SUBAGENT` 環境變數，設定了就直接退回原本的主線內執行（inline），不冒兩個執行緒同時打同一條 codex thread 的風險。
- 逐字引用安全閥（codex 中途要求看原文）在委派後改成一個新的暫停狀態 `awaiting-material`：subagent 回傳一個結構化的補件請求（不含未匿名化原文），主線決定要不要補、補多少，補好後派一個新的 subagent（同一個 `thread_id`）接續，不是原地等待——因為 subagent 一旦回傳結果，它的生命週期就結束了。

**明確不做的事（2026-08-12，使用者的判斷）**：
- 不處理「codex 那條 thread 自己的 context 累積太多」——沒有設閥值、沒有要求 codex 中途壓縮。理由：round cap 已經間接限制累積量，`docs/review-log.md` 顯示大多數審查落在 3-6 輪，遠低於會真的造成問題的量級；真的遇到高 cap 主題時，維持既有機制（producer 可提議調整 cap，經使用者確認），不另外疊加機制。
- 不處理「`thread_id` 本身失效（codex session 被刪除/過期）」——沒有自動偵測、沒有自動復原機制。理由：使用者判斷這種情況發生時，直接請 agent 建議開新 session 或指定要接續哪個審查即可，不需要為了一個還沒真實發生過的情況預先蓋一套復原機制。

這兩項列為已知、接受的限制（見 `SKILL.md` Setup 區塊「Delegated execution」一節的對應段落），不是遺漏。

## 為什麼刻意做得比較克制

`ADR-0012` 記錄了同一份 `SKILL.md` 先前一次審查裡，phase 狀態機從一個簡單構想一路被 20 輪追殺細節追到 codex 自己都出面建議「先凍結、別再加」。這次委派機制的設計過程（見下方驗證記錄）也出現了同樣的傾向——第一輪草案被要求縮小範圍，第二輪又冒出好幾個新的邊界情況（manifest 併發寫入、thread 失效、context 閥值）。這次選擇在「核心機制（範圍切分、manifest、單一寫入者、補件安全閥）」跟「邊界情況（thread 失效、context 閥值）」之間畫一條線，前者納入、後者明確擱置，而不是繼續往下追每一個理論上可能發生但還沒真的發生過的情況。

## 驗證記錄

沒有走 `review-collaboration` 自己的 Step 0-5 正式協定去審查這個決定本身（原因：這是在改這個 skill 自己的執行方式，用它自己的委派機制去審查自己的委派機制設計，順序上不合理）。改用與 `codex-peer-review` 那次相同的做法：由 Claude 自己派出兩輪獨立的 `Agent` 工具 subagent，各自用 `codex exec`（`gpt-5.6-sol`／`high`）對草案做結構化審查，全程不進主線對話：

- 第一輪（草案 v1，範圍是「Step 3-5 全部委派」）：codex 判定「有條件可行，細節不夠」，要求縮小範圍（Step 5 不該跟著委派）、`review-log.md` 單一寫入者、四項信任條件正式寫入、manifest 化、逐字引用安全閥另開暫停狀態。
- 第二輪（草案 v2，併入第一輪回饋＋使用者追加的兩個問題）：codex 判定「方向正確但仍有部分項目只解決表面」，並額外指出一個真正的內部矛盾（「協商中不准寫正式 log」vs「thread 失效要有東西可復原」）。使用者收到報告後，明確選擇「thread 失效與 context 閥值列為已知限制、不追加機制」，其餘 6 項用簡單文字規則收尾（不再送第三輪審查）。

該次 A/B 對照的附帶觀察（詳見 `codex-peer-review` 那次 `docs/review-log.md` 條目）：獨立、只拿摘要的 subagent 抓到真跑過程中被漏掉的真實 bug，不支持「context 隔離會讓討論品質變差」這個原始假設；本次委派提案的兩輪審查同樣得到有實質內容、扎實的 codex 回饋，沒有出現「因為看不到完整對話所以審查變空洞」的跡象。
