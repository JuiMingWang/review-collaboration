# 任務規格：方案 B —— SKILL.md 整套換成 v1 機制

**執行者**：Antigravity（透過 Herdr 派工）
**審核者**：Claude（主線程），使用者最終核准後才會真正覆寫正式技能檔
**狀態**：草案，等待使用者確認後才會實際派工

## 0. 背景（給沒有這段對話記憶的執行者看）

`~/.claude/skills/review-collaboration/SKILL.md` 是一份正式、目前在用的 Claude Code 技能檔：讓 Claude 主線程把一個討論結論拿去跟 Codex（另一個 AI）來回辯論，直到雙方沒有新的異議，或討論輪數到達上限、轉由使用者裁決。

這個 skillopt/review-collaboration-v1 專案（下稱「v1」）重新實作了「跟 Codex 來回辯論」這一段的核心機制，把原本靠 Claude 自己解讀自由文字、手動維護進度紀錄的做法，換成一套用固定表格格式（JSON schema）溝通、狀態存檔案、可斷點續跑的 PowerShell 程式（入口：`scripts/review-collab.ps1`）。v1 本身已經有 82 個自動化測試全部通過，是成熟、可信賴的既有成果，**這次任務不是重寫 v1，是把 v1 接進正式 SKILL.md，取代它原本手動維護的那一整套機制。**

## 1. 範圍與邊界（不可逾越）

**可以動的範圍**：
- 這個 v1 專案資料夾內的所有檔案（新增 adapter script、必要時修 v1 程式碼但要走 TDD）。
- 產出一份「建議寫入正式 SKILL.md 的新內容全文」草稿，放在這個 v1 專案的 `docs/` 底下（例如 `docs/skillmd-new-draft.md`），**不要直接改動或寫入正式技能檔本身**。

**絕對不能動**：
- 正式 `SKILL.md` 本體——這是使用者正在用的正式檔案，最終由 Claude 主線程審核你的草稿後才會親自覆寫，不假手你直接寫入。
- Herdr 裡任何工作目錄屬於使用者其他不相關個人專案的視窗/代理——不要碰、不要讀、不要寫。
- 這台電腦上這兩個範圍以外的任何檔案。

**技術邊界**：
- **不要真的呼叫 codex exec 花費 API 額度**，除非是第 4 節明講的「一次性最小煙霧測試」。整條迴圈邏輯先用 `tests/fixtures/fake-codex.ps1`（假的 Codex，測試用）跑通，不要用真的 Codex 反覆試錯。

## 2. 要做的 4 件事（逐項列出驗收標準）

### 2.1 建立正式的 Codex adapter script

新檔案（建議路徑 `scripts/adapters/codex-adapter.ps1`）。`Invoke-ReviewerCall`（`scripts/lib/ReviewerAdapter.psm1`）呼叫 reviewer 時，用固定介面附加參數：`-PromptFile <path> -OutFile <path> -EventsFile <path> [-ThreadId <id>]`（`-ThreadId` 只在有值時才會被附加，第一輪不會有這個參數）。這支 adapter 要接住這個固定介面，內部才去組真正的 `codex exec` 呼叫。

**必須原樣沿用**（已經是正式 SKILL.md 裡踩過雷、驗證過的做法，不要重新發明或簡化）：
- 固定旗標：`--ignore-user-config -m gpt-5.6-sol -c model_reasoning_effort=high --sandbox read-only --skip-git-repo-check`。
- schema 檔（指向 `schemas/reviewer-result.schema.json` 的內容）寫檔時必須 BOM-free UTF-8：`[System.IO.File]::WriteAllText($Path, $Json, (New-Object System.Text.UTF8Encoding $false))`，不能用 `Set-Content -Encoding utf8`（PS 5.1 會加 BOM，讓 codex 解析失敗）。
- 絕不重導向 codex 的 stderr（`2>` 或 `2>&1`）——PowerShell 5.1 下會把正常訊息包成 `NativeCommandError` 讓腳本誤判失敗。
- 送給 codex 的內容（`-PromptFile` 讀檔）要用 `-Encoding UTF8` 讀取，避免系統內碼頁（Big5/cp950）把中文內容讀壞。
- 呼叫前設定主控台編碼：`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` 與 `$OutputEncoding = [System.Text.Encoding]::UTF8`。
- 有 `-ThreadId` 時要用 `codex exec ... resume $ThreadId -`，沒有則是首輪呼叫，不帶 `resume`。
- 輸出寫到 `-OutFile` 指定路徑（`--output-schema` + `-o` 對應），events/stdout 寫到 `-EventsFile`。

**驗收標準**：這支 adapter 單獨用 `tests/fixtures/fake-codex.ps1` 的呼叫慣例對照過介面一致；並額外寫一份**只用假資料**的呼叫測試，確認固定旗標組合、schema 檔 BOM-free 這些規則都有被遵守（用程式檢查產生的實際命令列或寫出的 schema 檔位元組，不要只憑目視）。

### 2.2 Step 0-2 改成組出 v1 的 `package.md`

SKILL.md 現有 Step 0-2 的散文邏輯（找出真正在審查什麼、二元查證、起草摘要、checklist、跟使用者確認角度）**內容不變**，只改「最後組出什麼檔案」：從「`summary.md` + checklist 文字」改成組一份符合 `schemas/package-format.md` 規定的 `package.md`（10 個固定 marker，依序、不可重複：`# REVIEW PACKAGE` / `## Problem` / `## Current Conclusion` / `## Constraints` / `## Key Assumptions And Verification` / `## Alternatives Considered` / `## Unknowns` / `## Excluded Content` / `## Checklist` / `## Ceiling Breaker` / `## Evidence Sources`）。

**外加一件事（使用者已核准的折衷做法）**：在 `# REVIEW PACKAGE` **之前**加一段固定的角色框架前言（例如「你是獨立審查者，這是一個持續對話...」，沿用現有 SKILL.md round-1 prompt 開頭那段文字的精神）。`Test-PackageMarkers`（`scripts/lib/StateStore.psm1`）已確認**不要求** `# REVIEW PACKAGE` 是檔案第一行，只檢查 10 個 marker 依序出現，所以這樣做技術上合法。`## Ceiling Breaker` 段落照抄 SKILL.md 現有逐字文字，不要改寫。

**驗收標準**：寫一份範例 `package.md`，跑 `Test-PackageMarkers` 確認合法；人工比對 10 個 marker 的內容跟 SKILL.md 原本 Step 1/2 產出的資訊是否一一對應，沒有漏掉東西。

### 2.3 重寫「Delegated execution」與 Step 3-4：改成呼叫 v1 CLI 的迴圈

這是最核心的改動。子任務（沿用現有「委派給 subagent 執行，避免塞爆主線程 context」的設計，理由不變）裡的邏輯，從「自己手動呼叫 codex exec、解讀自由文字」，改成：

```
1. （只有第一次進這個審查時）呼叫 confirm-package，帶 -PackageFile <package.md路徑> -Cap <N> -MaterialCap 3
2. 迴圈：
   呼叫 advance -ReviewerExe <2.1 做的 adapter 路徑> -ReviewerArgs <固定參數，含 schema 檔路徑>
   讀回傳 JSON 的 next_action 欄位，分支：

   - "prepare_final_package"：CONSENSUS 達成。跳出迴圈，回報「共識package」給主線程 → 走 Step 5a。

   - "provide_producer_response"：呼叫 status 或用 advance 回傳的 artifact_refs.ledger 讀目前 open issues 清單，
     對每一筆逐一判斷 Fix（提出具體修正說明）或 Push back（不同意，寫出具體理由）——**這一步是唯一
     不能機械化的地方，需要真正的判斷力**，規則沿用 SKILL.md 現有 Step 4 的原則：不要為了結束迴圈而妥協，
     只有真的被說服才 Fix；每個 pushback 要標注查證狀態（可查證且已查證／可查證但未查證／純屬判斷）；
     同時必須對每個 issue 標注 reviewer_tag_plausible（Codex 原本標的查證狀態站不站得住腳，這是
     schemas/producer-response.schema.json 的強制欄位，不能省略）。
     寫成 producer-response-r<N>.json（符合 schemas/producer-response.schema.json），
     呼叫 submit -Kind producer-response -InputFile <該檔案>，回到步驟 2 開頭。

   - "provide_material_or_unavailable"：讀 advance 回傳的 artifact_refs.material_request 檔案，
     裡面每個 claim_id 對應 Codex 要求的一段補充資料。子任務沒有主線程的對話存取權，無法自己生出
     使用者原始資料——沿用現有 SKILL.md「awaiting-material」的精神：回報給主線程，由主線程（有對話
     歷史存取權）決定要不要提供、提供多少（同樣要經過 Step 1 查證分類、Step 2 匿名化，不能原文照搬），
     決定後寫 material-response-<claim_id>.json（符合 schemas/material-response.schema.json），
     呼叫 submit -Kind material-response -InputFile <該檔案>，回到步驟 2 開頭。
     （v1 本身已有補件次數上限，超過會自動變成 choose_arbitration，不用另外重寫這個上限邏輯。）

   - "choose_arbitration"：輪數上限或補件次數上限到了，Codex 仍未讓步。跳出迴圈，
     回報「未解決，卡在使用者仲裁」給主線程 → 走 Step 5b（沿用現有 Step 4b 的使用者選項：
     abandon 或 increase-cap，對應 submit -Kind arbitration）。

   - "resolve_manual_recovery"：技術性失敗（codex 呼叫本身出錯，不是內容分歧）。
     跳出迴圈，照實回報錯誤給主線程，不要猜測或重試超過 advance 自己內建的一次修復重試。
```

**中斷可接續怎麼處理**：v1 的 `review-state.json`（用 `Get-ActiveDir` 底下的檔案，`status` 指令可查）本身就是持久、可斷點續跑的狀態——**不需要**再像 SKILL.md 現有 Step 3-4 那樣自己維護一張 `phase` 狀態轉移表、自己算 round1-pending/round-pending 這些標籤。任何時候要恢復一個進行中的審查，第一步永遠是呼叫 `status`，讀 `human_state`/`wait_reason`/`next_action`，照上面的分支表決定下一步——這一段可以整個取代 SKILL.md 現有 Setup 段落裡那張很長的 phase transition table。

**驗收標準**：用 `tests/fixtures/fake-codex.ps1` 從頭到尾跑一次完整模擬（confirm-package → 多輪 advance/submit 迴圈 → 最終 CONSENSUS），並且**額外模擬**輪數到上限、補件次數到上限這兩種情境，確認都正確落到 choose_arbitration。這些模擬要嘛是新的 Pester 測試（優先），要嘛至少是有記錄、可重現的手動執行紀錄，不能只憑執行者口頭聲稱「測過了」。

### 2.4 `docs/review-log.md` 瘦身 + Step 5 改寫

`docs/review-log.md` 不再需要記錄 phase 狀態機（那套邏輯已經被 v1 的 `review-state.json` 取代），只需要保留：
- 這個審查的 `review_id`（給 `-ReviewId` 用）跟 v1 用的 `-ProjectRoot`（v1 存放狀態檔的根目錄，通常就是被審查的專案本身）。
- 兩個 v1 沒有涵蓋、明確決定維持獨立於 v1 之外的機制的資料：`sources_audited`（引用來源稽核清單）、`blind_pass_used`（是否跑過獨立盲測）——這兩個機制的呼叫方式不變（獨立 `codex exec` 呼叫，resume v1 追蹤的 `current_thread_id`，不計入 v1 的 round/cap）。

Step 5（Finalize）：CONSENSUS 後，準備 final package markdown、`submit -Kind final-package`，使用者確認後 `submit -Kind final-approval`，準備 handoff 內容後 `submit -Kind handoff`——這一步 v1 會自動把 package.md／final-package.md／handoff.json／所有 round 的 ledger 複製進歷史目錄並寫 `completion.json`，這已經涵蓋 SKILL.md 現有 Step 5a.3「manifest 保存」的語意，這段可以大幅簡化改寫，不用重新發明一次。

**驗收標準**：完整跑過一次 2.3 的模擬審查後，接著跑完 final-package → final-approval → handoff，確認 `completion.json` 跟歷史目錄底下的檔案都正確產生。

## 3. 每一步都要有的驗證證據（不是自己說有測就算）

每完成 2.1-2.4 其中一項，回報時要附：
- 跑了什麼指令/測試（可重現的確切指令，不是「我測過了」這種敘述）。
- 輸出結果（測試通過/失敗的實際訊息，不是摘要轉述）。
- 如果過程中發現原本規格有問題、或你做了跟這份規格不一樣的判斷，**明確列出**：改了什麼、為什麼改、跟這份規格原本寫的差在哪裡——不要默默改掉不提，也不要為了「看起來更好」就自行擴大範圍。

## 4. 真實 Codex 煙霧測試（唯一允許花真實額度的地方）

全部 4 件事用假 adapter 跑通、且 82 項既有 Pester 測試仍然全綠之後，才做**一次**最小的真實 codex 呼叫：用 2.1 做的 adapter，送一個極簡單的假審查內容（不用是真實案例），確認：
1. 固定旗標組合真的能讓 codex 正常回應（不是 CLI 語法錯誤）。
2. schema 檔真的能讓 codex 吐出符合 `reviewer-result.schema.json` 的合法 JSON。
3. 中文內容沒有變亂碼。

這一步做完就停，不要接著跑更多真實案例——後續是否要用真實案例驗證「角色框架前言是否真的讓 Codex 判斷更具體」，留給 Claude 主線程之後另外安排（那是這份規格以外的事）。

## 5. 完成後的交付物

- `scripts/adapters/codex-adapter.ps1`（新檔案）
- Step 0-2／Step 3-4／Setup／Step 5 的新版 SKILL.md 內容草稿：`docs/skillmd-new-draft.md`（完整可讀的 markdown，讓 Claude 主線程可以直接跟現有正式 SKILL.md 逐段比對審核，不要只給差異片段）
- 一份簡短的完成報告：4 件事各自的驗證證據連結/摘要、是否有偏離規格、還剩什麼沒做完
