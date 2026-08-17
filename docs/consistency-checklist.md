# review-collaboration-v1：跨文件一致性檢查清單

**目的**：取代「幫我全面檢查一次」這種開放式覆查（每次換個角度看，永遠可能找到新東西，沒有終點）。
這份清單改用固定、可窮舉的比對方式：把每個 schema 宣告的欄位／enum 值，逐一對照實際程式碼有沒有
真的驗證、有沒有真的產生。做完這一輪，這份清單本身就是新的穩定基準——之後重跑只要看清單裡的
項目有沒有變，不需要再重新用開放式閱讀找一次。

**檢查方法**：`schemas/*.json` 逐一對照 `Protocol.psm1`／`ReviewerAdapter.psm1`／`review-collab.ps1`
裡實際寫入或驗證這份 schema 的程式碼，人工逐行核對（非自動化工具跑的，屬於一次性人工稽核）。

**檢查時間**：2026-08-17。**結論**：找到 2 項需要修的真實落差（**已於同日修復**，見下），4 組已知（同一根因）的死值，其餘核對一致。

---

## 一、需要處理的真實落差（不是「已知簡化」，是實作跟自己宣告的 schema 不一致）

**兩項均已修復（2026-08-17）**——保留以下記錄作為「當初落差長什麼樣、為什麼會出現」的歷史說明，
不代表目前程式碼仍有此問題。修復內容：`Protocol.psm1` 的 `Test-HandoffShape` 已補上
`accepted_fixes`／`acceptance_criteria` 存在性檢查，並新增 `Test-MaterialResponseShape`；
`review-collab.ps1` 的 `material-response` 分支已呼叫該驗證函式。對應回歸測試見
`tests/Protocol.Tests.ps1`（`Test-HandoffShape`／`Test-MaterialResponseShape` 兩個 Describe 區塊），
全套 Pester 測試 81/81 通過。

### 1. `Test-HandoffShape` 沒有驗證 schema 要求的 `accepted_fixes`／`acceptance_criteria`

- **schema 說什麼**（`schemas/handoff.schema.json` 第 8-10 行）：這兩個欄位在 `required` 清單裡，是必填。
- **程式碼實際做什麼**（`Protocol.psm1` 的 `Test-HandoffShape`）：完全沒有檢查這兩個欄位存不存在。
- **有多嚴重**：`Test-HandoffShape` 是這份 handoff 唯一的把關者（v1 沒有跑真正的 JSON Schema 驗證器，
  全靠這個手寫函式）——代表少了這兩個欄位的 handoff 目前會被判定為合法，實際上違反了自己宣告的契約。
- **證據**：`tests/Protocol.Tests.ps1` 第 154-161 行的 `New-ValidHandoff` fixture 本身就沒放這兩個欄位，
  測試斷言 `Should Be $true` 通過——測試套件把這個落差原封不動鎖進去了，不會自己被抓出來。
- **建議動作**：在 `Test-HandoffShape` 補上這兩個欄位的存在性檢查（型別是 array，可以是空陣列，
  但至少要存在），並補一個「缺這兩個欄位應該要失敗」的回歸測試。這是小改動，不涉及設計取捨。

### 2. `submit -Kind material-response` 完全沒有 shape 驗證

- **schema 說什麼**：`schemas/material-response.schema.json` 定義了完整結構（`request_id`、`status` 二選一
  enum、`status=provided` 時 `excerpt` 必填且 `content` 上限 2000 字）。
- **程式碼實際做什麼**（`review-collab.ps1` 第 363-377 行）：內容直接從輸入檔原封不動寫進
  `rounds/material-response-<id>.json`，沒有呼叫任何驗證函式——對照同一段程式碼旁邊的
  `producer-response` 分支（會呼叫 `Test-ProducerResponseShape`），這裡明顯漏掉對應的驗證步驟。
- **有多嚴重**：比第 1 項嚴重，因為這份內容之後會被組進下一輪送給 Codex 的 prompt——格式錯誤或
  缺欄位不會在提交當下被擋下來，而是延遲到很後面（甚至可能完全不會，只是讓 Codex 收到奇怪的內容）
  才可能顯現，難以定位。
- **建議動作**：仿照 `Test-ProducerResponseShape`／`Test-HandoffShape` 的模式，在 `Protocol.psm1`
  新增 `Test-MaterialResponseShape`，`review-collab.ps1` 的 `material-response` 分支呼叫它，驗證失敗
  回傳 `Ok $false`（不寫入、不轉移狀態）。

---

## 二、已知的死值（schema 宣告了，但目前程式碼從未產生）——同一根因，不是各自獨立的問題

v1 是刻意從 diagnostic snapshot 那份更完整的設計裡，選擇只實作一個子集（例如：cap 後選 increase-cap
直接續行，不強制走 package 重新確認——這是 2026-08-17 使用者已核准的決定，見
`review-collab.ps1` 檔頭「已知簡化」與 `docs/session-log.md`）。以下 4 組是同一種模式在其他 schema 裡
的殘留：schema 檔案還留著當初完整設計的欄位/enum，但實際程式碼從沒有任何分支會產生它。
**這些不是 bug，是尚未實作或刻意不實作的行為**——列出來只是讓這份清單完整，不代表要修。

| Schema / 欄位 | 宣告的完整 enum | 實際會被產生的值 | 從沒被產生的值|
|---|---|---|---|
| `review-state.schema.json` → `wait_reason` | material-decision／**package-reconfirmation**／final-confirmation／arbitration／manual-recovery | 其餘 4 個 | `package-reconfirmation`（cap 修復已知決定） |
| `completion.schema.json` → `ended_reason` | consensus-finalized／**user-arbitrated-closed**／abandoned／superseded | 其餘 3 個（`-Reason` 參數用 `ValidateSet` 限制只能手動指定 abandoned／superseded） | `user-arbitrated-closed`（arbitration 選 abandon 時走的是 `terminate -Reason abandoned`，兩者在目前實作中沒有區分） |
| `review-state.schema.json` → `current_operation.kind` | review-call／**material-followup**／**protocol-repair** | 只有 `review-call` | `material-followup`、`protocol-repair` |
| `ledger-snapshot.schema.json` → `issues[].history[].event` | raised／**fix_proposed**／**pushback_raised**／fix_accepted／fix_insufficient／conceded／maintained／**reopened**／**duplicate_of**／reviewer_tag_disputed | raised、fix_accepted、fix_insufficient、conceded、maintained、reviewer_tag_disputed | `fix_proposed`、`pushback_raised`、`reopened`、`duplicate_of`（v1 沒有實作「重開」「標重複」這類進階語意，只有最基本的一輪一輪處置循環） |

**建議動作**：不用現在修。如果要修，有兩個方向：(a) 把 schema 裡這些死值刪掉，讓 schema 精準反映
v1 實際實作範圍；(b) 把對應行為補完整。這是設計層級的取捨（要不要把 v1 的範圍擴大），不在這份
清單自行決定，先列出來供之後參考。

---

## 三、核對過且一致的部分（不重複列出每一行，只記結論）

- `reviewer-result.schema.json` ↔ `ReviewerAdapter.psm1` 的 `Test-ReviewerResultShape`：欄位、enum
  逐項比對一致。2026-08-17 起 schema 已移除 `allOf/if/then/else`（Codex/OpenAI structured output
  不接受頂層 `allOf`，已實測），`MATERIAL_REQUIRED`／`CONSENSUS` 各自的條件邏輯現在只由
  `Test-ReviewerResultShape` 機械強制，schema 端只剩 description 文字提示，不再是雙重驗證。
- `producer-response.schema.json` ↔ `Protocol.psm1` 的 `Test-ProducerResponseShape`：欄位、enum、
  `fix`／`pushback` 各自必填欄位、`reviewer_tag_plausible=false` 必填理由，逐項一致。
- `operation-receipt.schema.json` ↔ `ReviewerAdapter.psm1` 的 receipt 建構：欄位結構一致。
- `ledger-snapshot.schema.json` → `issues[].status` enum ↔ `Protocol.psm1` 的 `Update-IssueStatus`：
  四個值（open／fixed-accepted／conceded／maintained-open）完全對應。
- `next_action` 全部可能值（`Get-NextAction`）跟 `review-collab.ps1` 各分支回傳的值互相對照，
  沒有發現遺漏或拼字不一致。
- `LegalTransitions`（`Protocol.psm1`）跟 `review-collab.ps1` 實際狀態轉移逐一比對，沒有發現非法轉移。

---

## 四、這份清單沒有涵蓋的事

- 沒有涵蓋「真實 Codex 能不能正確輸出符合 `reviewer-result.schema.json` 的內容」——這是
  `codex-integration-test-plan.md` Test 0 的範圍，屬於執行期風險，不是靜態文件一致性問題。
- 沒有涵蓋 `schemas/package-format.md`（純文字說明文件，非 JSON Schema，用途不同，未列入本輪逐欄位比對）。
- 沒有涵蓋 `tools/` 底下的視覺化腳本（`generate-flow-diagram.py`、`preview.html`）跟本清單發現的
  死值是否同步——這些是文件/圖表，不影響程式行為，優先度低。
