# 設計文件：把 v1 接進正式 SKILL.md（方案 A，局部接線）

**狀態**：草案，待使用者核准。核准後才進入階段 3（實際修改 SKILL.md）。
**範圍**：只換 SKILL.md Step 3-4（跟 Codex 來回判斷的機械迴圈）。Step 0-2（binary 查證、摘要、checklist、
anonymization）與 Step 5（finalize/arbitration、`docs/review-log.md` 寫入）維持在 SKILL.md 的散文流程裡，不動。

## 1. 確認的決定

- **協定改變（使用者已核准）**：Codex 實際被要求輸出的格式從「schema 只鎖 `verdict`，其餘寫成自由文字 `detail`」
  換成 v1 的結構化 schema（`outcome`／`dispositions[]`／`new_issues[]`／`material_requests[]`）。
  依據：2026-08-17 小規模真實 Codex 品質比較測試（見 `docs/session-log.md` 同日條目），沒有觀察到「表格
  讓判斷力明顯變空洞」的嚴重風險，可以接受。
- **折衷做法（使用者已核准）**：換協定不能只送裸的 `package.md`，要把 SKILL.md 現有、已驗證有效的框架文字
  一併送出去，理由見下方第 3 節。

## 2. 資料對應

| SKILL.md 現有概念 | v1 對應概念 | 備註 |
|---|---|---|
| `summary.md` + checklist | `package.md`（10 個固定 marker） | Step 1-2 產出的內容直接翻譯進對應 marker，不改變內容本身 |
| schema `{verdict, detail}` | `reviewer-result.schema.json` | round 1 起改用這份 schema 呼叫 Codex |
| `detail` 裡的自由文字 issue 清單 | `dispositions[]` / `new_issues[]` | 每個 issue 有 `issue_id`，程式可自動核對，不用 Claude 讀文字判斷 |
| `Fix` / `Push back` | `producer-response` 的 `action: fix / pushback` | `Test-ProducerResponseShape` 已驗證 reviewer_tag_plausible 等稽核欄位 |
| `CONCEDE` / `MAINTAIN`（純文字慣例） | `disposition: FIX_ACCEPTED / CONCEDE / FIX_INSUFFICIENT / MAINTAIN`（enum） | 從文字慣例變成 schema 強制的列舉值，更可靠 |
| Step 4b：cap 到達、MAINTAIN 未解 | `waiting-user/arbitration` | v1 的 cap 判斷（`Test-RoundAgainstCap`）取代 SKILL.md 自己算 round/cap 的散文邏輯 |
| Step 5b 使用者加碼 | `arbitration -Kind increase-cap` | 沿用 v1 已驗證過的「不強制重新 confirm-package」路徑（2026-08-17 cap 死路修復） |
| 「reviewer 要求更多資料」（自由文字偵測＋逐字引用，上限 3 次/每次 500 字） | `MATERIAL_REQUIRED` / `material_requests[]` / `material-response` | **見第 4 節，這裡有一個已知缺口要先補** |

## 3. 折衷做法：框架文字要放哪裡

**問題**：v1 目前送給 Codex 的 prompt 只有 `"ROUND N PACKAGE HASH ...\n" + package.md 內容`，完全沒有
SKILL.md 現有的角色框架（「你是獨立審查者」）、「稽核既有查證標籤，標錯要另外提出」這條行為指令。
2026-08-17 品質測試觀察到：少了這些指示文字，Codex 給出的替代方案比較籠統，也沒抓到刻意埋的查證標籤錯誤。

**做法（不改 v1 核心，只改 SKILL.md 這邊怎麼組裝要送出去的內容）**：

1. **角色框架＋「除了 checklist 還有沒有完全不同角度」這句固定指令**：`package-format.md` 的
   `## Ceiling Breaker` 本來就要求逐字照抄這句話，這部分已經涵蓋，不用改。
2. **「你是獨立審查者」的角色說明**：新增到 `package.md` 最前面（`# REVIEW PACKAGE` 之前），一個固定、
   不因主題而變的前言段落。需要先確認 `Test-PackageMarkers` 是否容許 marker 前面有內容——**待查證，
   階段 3 動手前先讀 `Protocol.psm1`／`StateStore.psm1` 的驗證邏輯確認，不確定就不要假設**。
3. **「稽核既有查證標籤」這條行為指令**：不放進 `package.md`（那是內容，不是指令），改成強化
   `reviewer-result.schema.json` 裡 `new_issues` 欄位的 `description` 文字，明講「包含稽核 Key Assumptions
   And Verification 裡的查證標籤是否合理，標籤錯誤時應在此提出」。這是小改動（改一行 description），
   不影響 schema 結構，跟這次 session 稍早補 schema description 的做法一致。
4. **`advisories` 欄位太籠統的問題**：同樣強化該欄位的 `description`，明講「列出具體可行的替代做法（例如
   可以怎麼做、用什麼機制），不要只給籠統方向」。

**這個折衷方式目前只有設計，還沒有實測驗證過**——階段 3 實際接線後，第一次真實測試時應該順便確認
這個折衷是否真的把「籠統」問題補回來，不是假設它有效就結案。

## 4. MATERIAL_REQUIRED 的已知缺口：沒有安全上限（**已修復，2026-08-17**）

**現況（修復前）**：SKILL.md 現有的「reviewer 要求更多資料」機制有明確上限——全程最多 3 次逐字引用、
每次不超過約 500 字。v1 的 `material_requests`/`material-response` 迴圈原本**沒有對應的次數或長度上限**。

**已修復**：`review-state.json` 新增 `material_cap`（預設 3，比照 `confirm-package -MaterialCap`）與
`material_requests_used`（累計已用掉的補件筆數，計的是 `material_requests[]` 項目數加總，不是輪次數）；
`Protocol.psm1` 新增 `Test-MaterialRequestsAgainstCap`；`review-collab.ps1` 在處理 `MATERIAL_REQUIRED`
時，累計筆數若加上這次要求會超過上限，改觸發 `waiting-user/arbitration`（使用者已核准這個行為選擇，
理由：跟輪數 cap 到達用同一套已驗證的 UX，補件被要求過多不是技術故障，應該讓使用者判斷要不要繼續配合，
不套用 `manual-recovery`）。TDD：先寫失敗的迴歸測試（連續 4 次 `MATERIAL_REQUIRED`，第 4 次應轉
arbitration）再修，`tests/ReviewCollab.EndToEnd.Tests.ps1`「補件次數上限」，全套 82/82 測試通過。

## 5. source-audit／blind-pass：維持獨立呼叫

這兩個機制（引用來源稽核、獨立盲測比對）**不透過 v1**，維持 SKILL.md 現有的散文邏輯直接呼叫
`codex exec`，共用 v1 記錄下來的 `thread_id`（resume 同一個 thread，v1 不需要知道這些呼叫發生過）。
理由：這兩個是「輪次之外」的呼叫，v1 的狀態機（`review-state.json`／`completed_round`）沒有對應概念，
硬塞進去會扭曲 v1 的 round/cap 語意，得不償失。`docs/review-log.md` 的 `sources_audited`／`blind_pass_used`
紀錄機制維持原樣。

## 6. 尚待處理／階段 3 才會確定的問題

1. `package.md` 是否能在 marker 前面加前言（見第 3 節第 2 點）——**已查證：`Test-PackageMarkers` 只檢查
   10 個 marker 依序、唯一出現，沒有規定 `# REVIEW PACKAGE` 必須是檔案第一行，可行，不需要改 v1 核心程式碼。**
2. Material request 上限的具體數字與超過上限的行為——**已確認並修復，見上方第 4 節。**
3. 折衷框架文字有沒有真的解決「籠統」問題——階段 3 第一次真實接線測試時一併驗證。
4. 目前有沒有用舊協定（自由文字）進行到一半的 `進行中` 審查案——換協定前需要先確認清空或個案處理，
   避免新舊協定的案子互相衝突。**待查證（讀各專案的 `docs/review-log.md`）。**
