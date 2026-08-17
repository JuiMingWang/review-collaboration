# review-collaboration-v1：真實 Codex 對接測試計畫

**狀態**：尚未執行任何一項，等使用者確認 Codex 額度足夠後再排入。本文件只列「要測什麼、為什麼、怎麼測、通過標準是什麼」，不包含測試結果。

**背景**：`skillopt/review-collaboration-v1/` 目前 73 個 Pester 測試全過，但全部指向假的 `tests/fixtures/fake-codex.ps1`，從未真正呼叫過 `codex exec`。這份文件是那道「最後一哩」的執行計畫。

---

## 0. 這次「整理」過程中發現的兩個關鍵落差（不是原本就知道，寫下來避免以後重踩）

### 0.1 CLI 介面不符——已修好，已用零成本方式驗證

`ReviewerAdapter.psm1`（`Invoke-ReviewerCall`）假設 Reviewer 命令認得固定旗標 `-PromptFile -OutFile -EventsFile [-ThreadId]`。但這台機器上已經被目前安裝的 `~/.claude/skills/review-collaboration/SKILL.md`（2026-08-14 版）實測驗證過的真正 `codex exec` 語法完全不是這樣：

```powershell
Get-Content -Raw $PromptFile | codex exec --json --output-schema $SchemaPath --ignore-user-config `
  -m <model> -c model_reasoning_effort=<effort> --sandbox read-only --skip-git-repo-check `
  -o $OutFile [resume $ThreadId] - > $EventsFile
```

直接把 `-ReviewerExe` 指到 `codex.exe` 會在第一次呼叫就因為旗標對不上而失敗（浪費一次真實呼叫的額度）。

**已修**：新增 `tools/real-codex-adapter.ps1`，把 v1 固定的呼叫介面翻譯成上面這個已驗證語法。已用一個不呼叫任何真實 API、只記錄自己收到什麼參數的假 `codex` 替身做過零成本乾跑，確認：
- 組出來的命令列旗標順序、內容跟已驗證語法逐一比對一致（含 `-m`／`-c model_reasoning_effort=`／`--sandbox read-only`／`--skip-git-repo-check`／`-o`／結尾的 `-`）。
- prompt 內容確實透過 stdin 正確送達（用字元數核對）。
- `-ThreadId` 有帶入時，`resume <id>` 出現在正確位置。
- 事件（`thread.started`／`turn.completed`）跟結果檔案的擷取路徑正確。
- 延續舊 SKILL.md 已驗證的安全考量：呼叫前切到全新拋棄式暫存目錄，不讓 codex 的工作目錄留在被審查專案內部。

過程中另外撞到一個純屬「假替身腳本本身是 PowerShell」才會發生的坑：`powershell.exe -File` 對單獨一個 `-` 字元引數有特殊解讀（保留給「從 stdin 讀腳本」用），會把要傳給腳本的那個 `-`（模擬「從 stdin 讀 prompt」的標記）攔截掉。改用 `-Command "& 'script.ps1' args"` 的呼叫形式解決。**這個坑只影響「用 PowerShell 腳本假扮 codex.exe」的測試替身本身，不影響 `real-codex-adapter.ps1` 呼叫真正 `codex.exe`（原生執行檔）那一步**——原生執行檔不會經過 `powershell.exe -File` 這層解析。

### 0.2 Schema 複雜度風險——**尚未驗證，是本測試計畫最優先要確認的事**

這是比介面不符更根本的風險。同一份已安裝 SKILL.md 記錄了一項先前的實測結論：

> 「empirical testing... found `enum`/`required`/`type` constraints are reliably enforced by codex's constrained decoding, but numeric-range constraints are not, and forcing nuanced writeups into rigid nested JSON degrades the writing.」

因此舊設計刻意把 `--output-schema` 限制到最簡單的形狀（只有 `verdict: enum` 一個欄位受 schema 約束，其餘用自由文字 `detail`）。

但 v1 的 `schemas/reviewer-result.schema.json` 遠比這複雜：巢狀陣列（`dispositions[]`／`new_issues[]`／`material_requests[]`）、陣列項目內的 `enum`／`pattern`／`required`，還有 **`allOf`/`if`/`then`/`else` 條件邏輯**（依 `outcome` 的值決定其他欄位的限制）。條件式 schema 是比「巢狀陣列」更進階的 JSON Schema 特性，比舊設計已經發現「不可靠」的東西更複雜，**沒有證據支持 codex 的 `--output-schema` 能可靠處理這個形狀**——不是「還沒測過」而已，是「已經有相反方向的證據」。

**這件事沒有預先修掉的原因**：要不要簡化 v1 的 schema（例如把 `allOf` 條件邏輯移出 schema、改成 Protocol.psm1 事後用程式碼交叉驗證，schema 本身只留 `type`/`enum`/`required`）是設計層級的取捨，不是我可以自己決定的執行細節——所以列成 Test 0，用最小成本先實測結果，再回來決定要不要動 schema。

---

## 1. 呼叫方式（Test 0 起，所有測試共用的骨架）

```powershell
# 先確認 codex CLI 本身可用（不花額度）
codex --version

powershell.exe -NoProfile -File scripts\review-collab.ps1 advance `
  -ProjectRoot <測試用暫存專案根目錄> -ReviewId <review_id> `
  -ReviewerExe powershell.exe `
  -ReviewerArgs @('-NoProfile', '-File', 'tools\real-codex-adapter.ps1', '-Model', 'gpt-5.6-luna', '-ReasoningEffort', 'medium')
```

**模型／推理深度用 `gpt-5.6-luna`／`medium`（使用者本次明確指定）**：這批測試的目的是驗證「連線與介面契約」（CLI 旗標、schema 是否被接受、事件格式、`thread_id` 何時出現、exit code 語意），不是驗證審查品質，所以不需要開到正式使用時的 `gpt-5.6-sol`／`high`（那是另一個決定，僅適用於正式審查，不是這批連線測試的預設）。

**務必用一個全新、乾淨、內容無關緊要的測試用專案根目錄**，不要指向 `agent_協作` 本身或任何真實工作中的專案——這批測試會真的呼叫 codex、真的寫入 `.review-collaboration/` 狀態目錄。

---

## 2. 測試案例（依優先順序，前面沒過就不用往後做）

### Test 0：schema 相容性＋最小連線（最優先、最便宜，先做這個）

**目的**：回答 0.2 節的風險——`codex exec --output-schema schemas/reviewer-result.schema.json` 到底能不能用。這是唯一一個「不知道會不會直接失敗」的測試，其餘測試都建立在它成功的前提上。

**步驟**：用最短的合法 package（沿用 `tests/StateStore.Tests.ps1` 裡 `New-ValidPackageContent` 那種最小內容即可）跑 `confirm-package` → 一次 `advance`。

**通過標準**：
- `codex exec` 的 exit code 是 0（不是因為 `--output-schema` 檔案本身被拒絕而失敗）。
- `-o` 指定的輸出檔案存在，且內容是合法 JSON，通過 `Test-ReviewerResultShape`（`ReviewerAdapter.psm1`）。
- 回傳的 `outcome` 欄位是三選一之一，不是被迫塞進奇怪格式的自由文字。

**如果失敗**：把 codex 實際回傳的原始內容記下來（`rounds\r1.json`／`.events.jsonl`），回來跟使用者一起判斷是要簡化 schema（拿掉 `allOf` 條件邏輯，交叉驗證移到 `Test-ReviewerResult` 事後檢查，這部分本來就存在）還是其他做法——這是設計決策，不在這份文件裡預先寫死答案。

### Test 1：ISSUES_RAISED → producer-response → 下一輪 CONSENSUS（驗證 thread 續接）

**目的**：Test 0 只驗證單輪。這裡驗證 `resume $ThreadId` 真的能讓 codex 記得上一輪的內容，事件裡的 `thread_id` 擷取時機是否跟假 adapter 模擬的一致。

**步驟**：故意在 package 裡留一個容易被挑出來的問題，讓 round 1 大概率是 `ISSUES_RAISED`；補交 producer-response 後送出 round 2。

**通過標準**：round 2 的 prompt 裡帶得到 round 1 的脈絡（codex 的回應顯示它知道自己在回應同一個討論，不是從零開始）；`thread_id` 全程一致。

**如果失敗**：這是唯一無法輕易「規避」的路徑——如果 resume 機制不可靠，代表整個多輪協商設計的前提動搖，需要停下來跟使用者討論，不要自己決定繞過。

### Test 2：cap 觸發 → increase-cap（這次修好的路徑，真實 codex 下走一次）

**目的**：這是本次 session 修的 bug，目前只有 fake adapter／Agy 獨立審查驗證過邏輯，從沒在真實 codex 的（較不可控的）回應內容下跑過。

**步驟**：cap 設低（例如 2），連續兩輪都不收斂，觸發仲裁，選 increase-cap，繼續送出下一輪。

**通過標準**：跟 Pester 測試裡驗證的行為一致——回到 `reviewing`／`provide_producer_response`，不卡在死路。

**優先度低於 Test 0／1**：這條路徑的機械邏輯已經雙重驗證過（Claude＋Agy），這裡只是確認「真實 codex 的回應內容」不會意外打破這個機制，風險低於前兩項。

### Test 3（可選，視額度再做）：MATERIAL_REQUIRED 補件迴圈

**目的**：確認 codex 真的會在需要更多資訊時回傳 `MATERIAL_REQUIRED`，而不是自己編造答案。

**優先度最低**：這個 outcome 能不能被真實觸發取決於 codex 當下的判斷，不是 Controller 能保證的，且目前測試套件對這條路徑的機械邏輯覆蓋已經很完整。額度不夠時第一個可以跳過。

---

## 3. 額度考量

**這份文件不擅自估計「剩餘週額度夠不夠」**——每次呼叫實際花多少額度，取決於 Codex 目前的計費/配額模型與這一輪 prompt／回應的長短，這些是會隨時間變動的現況型資訊，不是可以靠訓練知識可靠回答的問題。建議做法：

1. 先只做 **Test 0**（單輪、最短 prompt、`gpt-5.6-luna`——這是能做到的最小、最便宜的一次真實呼叫）。
2. 呼叫前後各查一次額度顯示（`codex` CLI 或 ChatGPT/OpenAI 帳號後台，這步驟需要使用者自己確認，不是我能訪問的資料），算出這一次呼叫實際消耗的比例。
3. 用這個實測出來的單次成本，回推剩餘額度夠不夠支撐 Test 1／Test 2／Test 3——不要在還沒有實測數字前就決定要不要往下做完整清單。

---

## 4. 這份計畫沒有涵蓋的事

- 不包含「如何簡化 `reviewer-result.schema.json`」的具體方案——如果 Test 0 失敗，那是下一步要跟使用者一起做的決定，不是這份文件的範圍。
- 不包含正式把 `review-collaboration-v1` 接回 `~/.claude/skills/review-collaboration/SKILL.md`（讓它成為真正會被呼叫的技能）的決定——這是另一個獨立的、更大的決策，等這裡的真實對接測試全部過了再談，見 `docs/session-log.md`。
