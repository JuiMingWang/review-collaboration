# review-collaboration 的 SKILL.md 本身，第一次用 codex-peer-review（而非 review-collaboration 自身）做全面審查

**Status**: accepted（2026-08-12，20 輪後 codex 回傳 APPROVED，審查結束）

背景：使用者要求對 `review-collaboration` 這個 skill 的設計本身做一次不限輪數、不用擔心 token 成本的全面審查，並且明確要求讓 codex 直接讀取整個專案的真實檔案（`CONTEXT.md`、全部 ADR、`docs/review-log.md`、codex 自己過去 session 的原始逐字稿），而不是像 review-collaboration 平常那樣只給合成過的摘要。這個需求本身跟 review-collaboration 的核心設計原則（禁止把原始檔案內容直接餵給審查者）直接衝突，所以改用 `codex-peer-review`——它原本就是設計來審查「已經存在硬碟上的檔案」、讓 codex 直接讀檔案本身，沒有輪數上限。這是選對工具，不是繞過限制。

模型／設定沿用 codex-peer-review 自己的預設：`gpt-5.6-sol`／`high`（不是 review-collaboration 平常用的 `gpt-5.6-luna`／`xhigh`）。

thread_id：`019ff1c1-b9b8-7653-bc6b-e973bc7cff5a`

## 決定

**Round 1（15 個問題，全部修正）**：
1. Step 3/4 的 PowerShell 執行範例改正——修掉不支援的 `<` 重導向、補上原本未賦值的 `$PromptFile`/`$RoundPromptFile`、修正 `Select-String` 回傳的是 `MatchInfo` 物件而非字串。
2. 更正「CONCEDE/MAINTAIN 受 schema 約束」這個錯誤敘述——schema 只約束頂層 `verdict`，CONCEDE/MAINTAIN 其實是 `detail` 裡的自由文字慣例。
3. JSON 完全無法解析時的 fallback，改成跟非零 exit code 同等處理（中止、不假造 `detail`），不是直接當 `ISSUES_RAISED` 繼續。
4. Round 1 直接 CONSENSUS 時，補上「若有使用參考來源，ADR-0007 要求的揭露/稽核輪次仍必須執行，不能被 round 1 的共識跳過」的規則。
5. 誠實承認同一次呼叫內的「兩階段盲掃」不是真正獨立測試（見 ADR-0006 補充），只是弱訊號；補上真正獨立版本（獨立 fresh thread 呼叫）當高風險主題的可選加強。
6. 修正歷史依賴檢查的機械篩選規則——拿掉不存在的 `status="有效"`（真實狀態值只有「進行中」「已審查 · 達成共識」「已審查 · 使用者裁決結束」），改成只靠關鍵字比對，並具體定義關鍵字怎麼選（問題/目標敘述裡的專有名詞、機制名稱）。
7. 「10-20 次校準」從「跨專案累積」改成「逐專案各自累積」，因為 `docs/review-log.md`本來就是逐專案分開存放，沒有跨專案計數的機制。
8. 把 Retrospective 機制的三個固定觸發點，實際掛進 Step 0 讀 review-log 的步驟裡——這個 skill 只能被動觸發，Step 0 的每次調用就是這個機制唯一真正會被檢查到的時機點。
9. 補上「跨 session 恢復遺失的是談判狀態」的處理方式——`$Dir` 遺失時，要求向 codex 要一份牠自己 thread 記憶裡的現況摘要，而不是憑空重新猜測。
10. 修正「codex session 逐字稿是不可竄改的稽核軌跡」這個誇大敘述——改成「本 skill 自身的流程不會偽造它」，同時誠實揭露它仍是本機、未簽章、使用者可寫入的檔案；並揭露 tripwire 雜湊只涵蓋 round 1 的 summary+checklist，不涵蓋後續輪次累積的 Fix 內容。
11. 修正查證分類的角色分工跟 `CONTEXT.md` 已經漂移的問題——`CONTEXT.md` 原文寫「審查者從零分類」，但實際落地是「產出者草擬時分類、審查者負責稽核」，兩邊都已對齊修正（`CONTEXT.md` 同步更新）；並在送給 codex 的 prompt 裡明確加入「稽核產出者標籤是否合理」的指示。
12. 補上「敏感但關鍵的資訊被排除時，不能讓審查直接取得無條件共識」的規則。
13. 逐字引用安全閥的來源定位規則，拆成「有檔案可查」跟「純對話、沒有穩定檔案可雜湊」兩種情況分開處理——原規則只設計給檔案型輸入，但這個 skill 主要審查的是對話。
14. Step 0 明確規定：使用者一次選多個主題時，每個主題仍各自獨立一套 `$Dir`/thread/cap/log entry，不能塞進同一個 thread。
15. 修正「已有 a handful of live reviews」這句對實際使用量的誇大敘述，改成如實反映 `docs/review-log.md` 的真實筆數，並揭露這批樣本大多是這個 skill 在審查自己的設計（自我指涉樣本）。

採納 3 項建議、婉拒 1 項：
- 採納：使用者已明確指定單一主題時，Step 0 確認可以簡化，不用重列全部候選。
- 採納：逐字引用上限（15 行/500 字）加上「可附理由例外突破」的彈性。
- 採納：分批審查的「無重疊」自我判斷，明確邀請 codex 挑戰這個判斷，不只是留紀錄。
- 婉拒：改變 ADR-0007 已經談定的「使用者無法判斷來源適配時，預設不用該來源」這個預設值——codex 在 round 2 確認這只是 advisory、不是必須現在處理的問題，維持原判斷不變。

**Round 2（7 個新問題，全部修正）**——round 1 的部分修正本身不夠完整，被 codex 抓到：
1. PowerShell 範例的 `$PromptText`/`$RoundPromptText` 仍未定義、非零 exit 分支只有註解沒有真的中止執行、`$ThreadId` 為空時沒有對應的失敗處理——三者都補上明確的中止/失敗路徑。
2. 新增的「真正獨立 blind pass」缺乏生命週期規則——補上：沿用同一個 `$Dir`（不另開）、輸出檔另外命名、不需要追蹤它自己的 thread_id、發現的內容只是參考訊號不是正式 issue、不計入輪數上限。
3. 「來源適配揭露/稽核輪次」跟「使用者可自訂的輪數上限」之間的衝突——明確規定這個揭露輪次不計入協商用的輪數上限，是額外的必經步驟，不是違反使用者訂的 cap。
4. Round 1 對 audit trail／tripwire 的修正留下兩處自相矛盾——「不可竄改」改口後，後文仍寫著「證明審查真的發生過」；雜湊範圍在兩處分別寫成「round-1」跟「final round」。兩處都已對齊修正為一致敘述。
5. 20 筆後的關鍵字篩選仍嫌不夠具體——補上明確規則（比對問題/目標敘述裡的專有名詞/機制名稱，逐條目標題+結論欄位做不分大小寫的子字串比對），並誠實承認同義詞漏抓是已知、由 10-20 次校準點的全量掃描負責兜底的殘留風險，不是這一步要解決的問題。
6. Trial logging 的五類資料沒有實際寫入位置——補上：寫在 Step 5a.3 的 `docs/review-log.md` manifest 裡，沒有另外的檔案；即使審查走到 Step 5b（未達共識）也要記錄已累積的 trial 資料，不能因為沒共識就不記。
7. `SKILL.md` 這次的修正內容已經跟 ADR-0011、ADR-0006 的原始文字產生新的落差——本文件（ADR-0012）記錄這次的修正內容；ADR-0006 補上一段簡短更正說明第 2 點的敘述已改口。

**Round 3（3 個新問題，全部修正）**：
1. PowerShell 失敗分支的 `throw` 沒有真的中止：round 2 只在註解寫「STOP HERE」，沒有真的中止執行；`$RoundPromptText` 也沒有補上跟 `$PromptText` 一樣的組裝說明註解。改成真的用 `throw` 中止，兩個變數都補上註解。
2. 「真正獨立 blind pass」的發現可能被靜默丟棄：補上「blind pass 對照第一輪結果」在接受第一輪 `CONSENSUS` 前是強制步驟；並誠實揭露它不追蹤自己的 `thread_id`，`$Dir` 刪除後沒有持久定位方式，這是刻意的取捨（偶發、僅供參考用途），不是遺漏。
3. 來源稽核可能在 cap=1 又遇到第一輪 `ISSUES_RAISED` 時被跳過：改成無論第一輪結果是共識還是有異議、無論 cap 多少，來源稽核輪都必須在任何終止路徑（Step 4／5a／5b）之前執行。

採納 1 項建議：ADR-0012 狀態文字微調（見上）。

**Round 4（5 個新問題，全部修正）**：
1. Step 3 的派送邏輯文字本身沒有真的接上 blind-pass 比對閘門——雖然規則寫在別處，但 Step 3 逐字讀仍是直接跳過。改寫 Step 3 的派送段落，把「來源稽核」「blind-pass 比對」「cap 檢查」三個步驟明確依序寫在同一段，逐字可執行。
2. 第一輪已經是 `ISSUES_RAISED` 時，blind-pass 獨有的發現仍可能被丟棄——舊規則只講「接受共識前」要比對。改成不論第一輪結果是共識或有異議，都要做這個比對。
3. `cap=1` 時仍會多送一輪：原本的派送邏輯是先進 Step 4（送出下一輪），讀到回覆才檢查 cap，導致 cap=1 時已經多送了一輪才發現該停。改成在派送前就先檢查「第一輪是否已達 cap」，達到就直接進 Step 5b，不再送出第二輪。
4. Step 4 的失敗訊息指向不存在的 events log 檔案：Step 4 的 `codex exec` 呼叫原本沒有 `--json` 也沒有把輸出重導到 events 檔，補上跟 Step 3 一致的 `--json` + 重導。
5. Step 3 非零 exit 時，`進行中` log 與 `thread_id` 擷取都寫在成功分支之後，導致「非零 exit 但已擷取到 thread_id」這個 Failure Modes 表格描述的情境實際上不可能發生。改成非零 exit 前先嘗試擷取 thread_id（codex 可能先送出 `thread.started` 事件才在稍後失敗），擷取到就先記錄，再 `throw` 中止。

**Round 5（4 個新問題，全部修正）**：
1. 非零退出時的 `進行中` 紀錄仍只是註解、沒有真的寫入：把失敗分支的註解改寫成明確的行動指示（「這是真的動作，不是備忘」），並讓成功路徑那句「Update docs/review-log.md」明確交代兩條路徑共用同一個動作。
2. 來源揭露／稽核輪缺少可執行的呼叫生命週期：補上完整規格——resume 同一個 `$ThreadId`、輸出到 `$Dir\r1s.json`、事件檔 `$Dir\r1s.events.jsonl`、沿用同一個 schema、失敗處理比照 round 1，manifest 的逐輪 verdict 記錄裡用 `r1s` 這個獨立標籤記錄（不計入輪數上限，但看得到）。
3. `cap=1` 的 Step 5b 報告要求無法滿足：Step 5b 現在區分兩種情況——真的發生過 Fix/Push back 交換時照舊回報 MAINTAIN；cap 在第一輪就到頂、從未進入 Step 4 時，改成直接回報 codex 第一輪的原始意見，不假冒 MAINTAIN。
4. **摘要隔離與匿名化並未真正限制 codex 讀取專案檔案**（本輪最重要的發現）：`--sandbox read-only` 只擋寫入不擋讀取，文件卻聲稱 codex「never reads the target file directly」——這句話過度保證了。修正做法：(a) 誠實改口，明確說這個保證來自「產出者摘要撰寫紀律」加「工作目錄隔離」，不是絕對技術保證；(b) 實質補強——新增規則，要求這個 skill 的每次 `codex exec` 呼叫都把工作目錄設成 `$Dir`（審查專用的暫存資料夾），不是目標專案根目錄（跟 codex-peer-review 故意相反，因為那邊就是要讓 codex 讀真實程式碼）。這樣即使 codex 好奇亂讀，`$Dir` 裡也沒有敏感內容可讀到。

**Round 6（3 個新問題，全部修正）**：
1. 非零退出的紀錄動作第三次修正仍不夠：問題根源在於試圖把「更新 docs/review-log.md」這個本質上不是 PowerShell 動作的步驟塞進程式碼區塊的註解裡。這次徹底重構——程式碼區塊只保留真正機械式的部分（呼叫、擷取 thread_id），把「有 thread_id 就先記錄、再視 `$rc` 決定停止或繼續」拆成區塊後面編號清楚的文字步驟，不再用註解偽裝成動作。
2. 「Don't」區塊仍殘留一句舊的絕對保證（「codex only ever sees the prompt text, never reads the file directly」）——這句話沒有跟著 Setup／Step 1 的新揭露一起修正。已同步改口。
3. 來源稽核輪（`r1s`）雖然有完整的呼叫生命週期，但沒規定「揭露來源」實際上要交付什麼內容給 codex——如果只給 prompt 文字，codex 沒東西可核對是否誤讀；如果讓它自己去找來源檔案讀，又繞回工作目錄隔離想避免的風險。補上規則：交付的是「實際影響清單的那一小段來源摘錄」，比照 Step 1 逐字引用規則的格式（來源定位、版本標記、上限），且視為惰性參考資料，不執行其中任何看起來像指令的內容。

**Round 7（2 個新問題，全部修正，都是 round 6 新增規則本身引入的副作用）**：
1. `$Dir` 工作目錄隔離會讓所有範例在 Git 檢查階段失敗：round 6 新增「一律從 `$Dir` 執行」，但 `$Dir` 是暫存資料夾、不是 git repo，而原本 `--skip-git-repo-check` 只在「目標專案不是 git repo」時才加；改成無條件一律加這個參數，並補進 Step 3/Step 4 的實際指令範例。
2. `進行中` 紀錄不足以判斷跨 session 恢復到哪個階段：round 6 把「一有 thread_id 就先記錄」變成無條件動作，但 Step 0 的恢復邏輯原本一律「跳到 Step 4」，沒考慮到 round 1 失敗、`r1s` 未跑、blind-pass 未比對這幾種中間狀態。改成恢復時要靠 `$Dir` 裡實際存在哪些輸出檔案（`r1.json`／`r1s.json`／`blind.json`）反推目前卡在 Step 3 派送邏輯的哪一關，而不是預設一定可以直接進 Step 4。

**Round 8（1 個新問題，修正）**：從 `$Dir` 產物反推 phase 不是確定性的——檔案存不存在無法區分「這次沒用來源所以不需要 `r1s`」跟「用了來源但 `r1s` 還沒跑」，也無法判斷某個輸出檔是成功產生還是失敗留下的殘骸。改成在 `進行中` log entry 裡直接持久記錄三個欄位：`phase`（`round1-pending`／`source-check-pending`／`blind-check-pending`／`dispatch-ready`／`negotiating`）、`source_used`、`blind_pass_used`——每個階段轉換時明確更新，恢復時直接讀這些欄位決定下一步，不再靠猜檔案。（round 9 指出這個 `phase` 集合本身仍不完整，見下——round 8 當時的「deterministic」敘述在 round 9 修正前並不完全成立。）

**Round 9（3 個新問題，全部修正）**：
1. phase 集合缺少「等待使用者決定」的狀態：`Step 5a`（等待使用者確認最終包裹）跟 `Step 5b`（等待使用者裁決）都沒有對應 phase，導致這期間如果跨 session 恢復，會被誤判成 `negotiating` 而錯誤地重新啟動協商。新增 `awaiting-confirmation`／`awaiting-arbitration` 兩個 phase，在進入 Step 5a／5b 時就先寫入。
2. `round1-pending` 的恢復動作沒有唯一規格：補上明確程序——resume 既有 `$ThreadId`（絕不開新 thread），請 codex 說明它是否已經對第一輪產出結論、有的話原樣重述；沒有的話（例如中途掛掉）才把原始 round 1 prompt 當作這個 thread 的下一則訊息重送。
3. `$Dir` 遺失時，光有 phase 不足以重建實際需要的內容：補上規則——`source-check-pending` 之後（含）的各 phase 都有活著的 `$ThreadId`，遺失 `$Dir` 時 resume 該 thread、請 codex 重述目前完整狀態（round 1 結論、`r1s` 結果、累積中的 issue list）來重建；唯獨 `blind-check-pending` 是例外——盲測本來就刻意不留存自己的 thread_id（這是有意的設計取捨，理由見 round 5），所以這個階段遺失 `$Dir` 時的正確做法是直接重跑一次盲測，不是嘗試恢復，因為盲測本質上就是一次獨立、無狀態的檢查，重跑一次不是降級，是它原本的設計就允許的做法。

**Round 10（3 個新問題 + 1 個建議，全部採納）**：
1. `dispatch-ready` 階段的 blind-pass 發現仍可能遺失：即使已經把 blind-only 發現併入 issue list，這個內容本身只存在 `$Dir`；`$Dir` 遺失時 main thread 從沒看過這個發現，recap 救不回來。補上規則：這個併入結果要另外用一行文字寫進 log entry 本身，不只是靠 `$Dir` 裡的檔案；缺這行文字時，比照 `blind-check-pending` 直接重跑盲測。
2. 使用者在 `awaiting-arbitration` 選擇「加入輸入、繼續」後，phase 沒有更新：補上規則，選擇當下立刻把 phase 轉回 `negotiating`，不留在 `awaiting-arbitration`（避免恢復時重複呈現已回答過的裁決問題、遺失新輸入）。
3. `$Dir` 遺失後，用 codex recap 或重做 Step 1-2 重建的內容，拿去算 round-1 tripwire hash 會誤導：這種重建是語意相近，不是逐字相同。補上規則：這種情況下 manifest 的 hash 欄位要明記「unavailable，因為原始內容已重建、非逐字雜湊」，不能假裝算出一個看起來正常的雜湊值。
4. **建議採納**：把分散在 Step 0／3／5 的 phase 規則整理成一張「事件 → 新 phase → 必須持久化的資料」轉移表，集中放在 Setup 區塊，作為之後新增分支時唯一要維護的權威來源，取代散落各處、容易顧此失彼的散文敘述。

**Round 11（2 個新問題 + 2 個建議，全部採納）**：
1. Step 5b「加入輸入並繼續」立刻設成 `negotiating`太早——這時新輸入還沒走完 Step 1/2、也還沒送給 codex，此時中斷會讓恢復流程誤以為已經有一輪在進行中。新增中繼 phase `arbitration-input-pending`，持久保存原始輸入與重設後的輪數上限，等實際送出後才轉成 `negotiating`。
2. 「round-1 內容曾被重建」沒有即時持久化，只在最終 manifest 才標記——如果重建後 `$Dir` 被重新建立、又跨一次 session 遺失，下一個 agent 可能誤把重建內容當原始內容算雜湊。改成一發現需要重建就立刻寫入 `round1_content: reconstructed` 旗標，不等到 Step 5。
3. **建議採納**：Step 3 原本重複描述整個 phase 轉移邏輯，跟新表格重複、之後容易兩邊各自漂移——精簡成只保留 Step 3 專屬的動作，其餘轉移一律指向表格。
4. **建議採納**：Step 5b 使用者裁決終止時，比照 Step 5a.5 補上刪除 `$Dir` 的步驟，避免終止後留下暫存檔案。

**Round 12（3 個新問題，全部修正）**：
1. `arbitration-input-pending` 原本要求把使用者原始輸入直接寫進 `docs/review-log.md`——這發生在 Step 1 敏感內容排除、Step 2 匿名化之前，等於讓未過濾內容直接進入專案追蹤檔，跟既有敏感內容規則衝突。改成寫進 `$Dir\arbitration_input.txt`（跟 `summary.md`一樣是可拋棄的暫存檔），log entry 只記錄「這個檔案存在、phase 是什麼」，不含實際內容；`$Dir` 遺失時這份輸入無法復原（codex 從沒看過），直接請使用者重講一次即可，不用嘗試重建。
2. 「fresh round budget」沒定義怎麼跟累積輪號接軌：補上精確定義——不是重設回一個可能已經超過的小數字，而是跟使用者確認「再加幾輪」（預設跟原本上限一樣大），把這個數字加到已經跑到的輪數上，變成新的絕對上限。
3. Step 5b 重新走 Step 2 時，新輸入若引用了原本沒用過的參考來源，沒有對應的來源稽核生命週期：說明這種情況下重新跑 Step 2 本來就會重新判斷 `source_used`，一旦這次翻成 true，就要比照 round 1 的規則跑強制揭露/稽核輪，不能因為 round 1 沒用過就跳過。

**Round 13（3 個新問題，全部修正）**：
1. `$Dir\arbitration_input.txt` 還是把未處理輸入暴露給 codex——因為 round 6 已經規定所有 `codex exec` 都從 `$Dir` 執行，把輸入放在 `$Dir` 裡面剛好正面違反同一條隔離規則。改成放進一個跟 `$Dir`平行、不會被當作任何 codex 呼叫工作目錄的獨立暫存資料夾（`$InputDir`）。
2. `source_used` 單一布林值無法表示「換了來源」或「新增來源」：改成 `sources_audited`（已稽核來源清單），每一輪都重新檢查這輪的 checklist 是否用到不在清單裡的來源，稽核完才把該來源加進清單——不再是「第一次翻成 true 就不會再觸發」的單向旗標。
3. 來源稽核機制原本硬綁在 round 1（`r1s`），重啟後的新一輪沒有對應生命週期：把整個機制從「round 1 專屬」通用化成「任何一輪都適用」，命名也從 `r1s` 廣義化成 `r<N>s`（依附在觸發它的那一輪），phase、輸出檔、事件檔、失敗處理、manifest 標籤規則全部比照辦理，不再是 round 1 的特例。

**Round 14（3 個新問題 + 1 個建議，全部修正/採納）**：
1. `$InputDir` 沒有實際的建立/刪除生命週期：補上——由 `$ReviewKey`（可從 `$Dir` 名稱反推）決定路徑、第一次真的需要時才建立、Step 5a/5b 兩種終止路徑都要刪除。
2. `sources_audited` 只用名稱識別，處理不了同名來源換版本、或同一輪用到多個新來源：改成 `{source, version_or_snapshot}` pair 的清單，且一輪可能同時有多個未稽核來源時，要全部稽核完才能離開 `source-check-pending`，稽核呼叫加上 `k` 計數器（`r1s1`、`r1s2`……）。
3. 通用化後的 `r<N>s` 機制沒有真的接上 Step 4 的控制流——Step 4 自己維護一份簡化過的 CONSENSUS/cap 判斷，沒有呼叫回 Step 3 的三項派送檢查，導致晚期輪次的新來源稽核可能被繞過。改成把 Step 3 的三項檢查明確定義成「每一輪跑完都要重跑一次」的共用程序，Step 4 結尾改成呼叫同一套邏輯，不再各自維護一份。
4. **建議採納**：清掉文件裡殘留的 `r1s` 字樣，統一改成 `r<N>s`。

**Round 15（2 個新問題 + 1 個建議，全部修正/採納）**：
1. Phase transition table 沒跟著 Step 3 內文一起改成多來源模型：補上——一輪可能有多個未稽核來源時，要把整個待稽核佇列（不只是一個來源）跟目前的 `k` 一起持久化，佇列清空前都停在 `source-check-pending`。
2. `{source, version_or_snapshot}` 仍無法處理「同一來源同一版本、支援全新一段 checklist 內容」的情況：改成三元組 `{source, version_or_snapshot, excerpt_hash}`——用實際揭露片段的內容雜湊當第三個身分欄位，同來源同版本但揭露了不同片段，雜湊不同，正確判定為未稽核。
3. **建議採納**：Step 5b.3 直接寫明同時刪除 `$Dir` 與 `$InputDir`，不再只靠「同 Step 5a.5」間接帶出。

**Round 16（2 個問題修正 + 1 個問題反駁 + 1 個建議採納）**：
1. round 2 以後的協商輪次沒有等價於 round 1 的「回應待確認」phase：補上通用的 `round-pending`（含 `pending_round: N`），恢復程序跟 `round1-pending`相同（resume thread、請 codex 覆述或確認、必要時才重送）。
2. 多來源稽核的 `k` 沒有被要求持久化：補上——每完成一個 `r<N>s<k>` 都要把遞增後的 `k` 一起寫回，避免中斷在 s1、s2 之間時檔名衝突覆蓋。
3. **反駁（純屬判斷，未修正）**：codex 認為 `excerpt_hash` 相同但支援「全新 checklist 用途」時應該觸發新稽核。判斷理由：稽核機制要驗證的是「這段摘錄本身的來源可信度與版本正確性」，不是「這段摘錄這次被拿來支持哪句 checklist 文字」——一旦內容跟版本都沒變，可信度這件事本身沒有變化；摘錄被套用在新的 checklist 措辭夠不夠恰當，本來就在 Step 4 每輪的一般性 Fix/Push back 討論範圍內，不需要為了同一件事疊加第四個身分維度再稽核一次。這屬於「要不要為一個已經被其他機制涵蓋的假設情境，再加一層規則」的設計判斷，不是查證問題；已在 round 17 送出反駁，等 codex CONCEDE 或 MAINTAIN。
4. **建議採納**：phase table 的終止列也直接列出同時刪除 `$Dir` 與 `$InputDir`。

**Round 17（codex MAINTAIN 前次反駁 + 3 個新問題，全部處理）**：
1. **前次反駁的結果：改為 CONCEDE**。codex 指出 ADR-0007 的稽核本來就包含「這段摘錄對『這次要支持的 checklist 項目』是否適配、有沒有被誤讀」，不只是驗證摘錄本身的可信度——同一摘錄支援不同 checklist 項目時，適配性問題確實是新的、沒被涵蓋過。這個反駁角度是對的，round 16 的反駁站不住腳，收回。改成四元組 `{source, version_or_snapshot, excerpt_hash, usage_hash}`，第四個欄位是「這段摘錄這次支持的 checklist 內容」的雜湊。
2. `round-pending` 沒有套用到 Step 5b 重啟送出的那一輪：補上——Step 5b 重啟的新輸入實際送出前，一樣要先進 `round-pending`，確認完成後才轉 `negotiating`，不能直接跳過去。
3. `round-pending` 的寫入順序本身有問題：先寫 phase 再寫提示檔的話，中斷在兩者之間會留下「有 pending 狀態、卻沒有提示可重送」的不可恢復狀態。這個問題也同時出現在來源稽核呼叫本身（`r<N>s<k>` 完成到寫回 `sources_audited`／`k` 之間的窗口）。**統一解法**：整份文件目前用到的所有 codex exec 呼叫（round 1、後續每一輪、每個 `r<N>s<k>`）都改成共用同一套「先寫提示檔、再寫 pending phase、再呼叫、恢復時一律 recap-or-resend 確認過才信任結果」的固定程序，寫在 Setup 區塊一次，取代原本三個地方各自描述、容易各自漂移的寫法。

**Round 18（4 個新問題，全部修正）**：
1. safe-call 程序「不能只因呼叫返回就信任結果」的寫法會造成無限遞迴（recap 呼叫本身也要再 recap）：修正成——正常、連續執行內完成的呼叫（exit code 0、輸出符合 schema）直接信任；recap-or-resend 只用在「之後一個獨立的恢復流程發現 pending 狀態」這種情境，不是每次呼叫都要做。
2. safe-call 宣稱涵蓋所有呼叫，但 round 1 跟獨立 blind pass 其實做不到：round 1 呼叫前根本沒有 `$ThreadId` 可以先記錄；blind pass 本來就刻意不留存 thread_id／phase（round 5 的既有決定）。改成明確列出這兩個例外，各自維持原本已有的處理方式，不假裝套用同一套程序。
3. `source-check-pending` 仍可能在 `k=1` 的提示檔存在前就被持久化：改成「進入 `source-check-pending`」跟「`k=1` 開始它自己的 safe-call」是同一件事，不是兩個有間隔的步驟。
4. Step 5b 重啟 round 確認完成後，仍直接跳到 `negotiating`，繞過共用的 post-round dispatch：改成跟其他輪次一樣，確認後要先走一次完整的三項派送檢查，才能依結果決定停在哪個 phase——不然會漏掉 cap 判斷或這次可能出現的新來源稽核。

**Round 19（2 個新問題，全部修正）**：
1. `k≥2` 的轉移仍違反「提示檔先行」規則：round 18 只封住 `k=1`（進入 `source-check-pending`），但 `k=1→k=2` 這種後續轉移一樣可能在提示檔存在前就把新 `k` 寫進去。改成每次 `k` 遞增都要重複同一條規則：先寫好新 `k` 的提示檔，才能一起持久化更新後的清單／佇列／`k`，不是一次性只套用在第一個。
2. `source-check-pending` 的恢復指令跟 safe-call 修正後的定義互相矛盾：Step 0 原本寫「直接送出下一個 `r<N>s`」，跟 safe-call「resume 時要先 recap-or-resend、不能直接重送」衝突。統一成 Step 0 的敘述也遵守同一條規則——先確認目前這個 `k` 的狀態，才繼續處理佇列剩下的部分。

**Round 20（最終輪，APPROVED）**：修正 round 19 的兩個問題後，主動請 codex 對整個恢復機制做「是否已超過目前使用量所需複雜度」的比例評估（呼應這次審查一開始就要求的「訂邊界 vs 限制判斷」視角）。codex 給了誠實評估（見下），同時給出 APPROVED。

## codex 的比例評估（誠實揭露，不是「沒問題」的背書）

codex 明確指出：`phase` 欄位跟通用 safe-call 程序解決了真實問題、值得保留；但四元組來源身分、完整待稽核佇列、逐次 `k` 持久化，以及對每個極小中斷窗口的精確恢復，是在保護「目前實際使用量裡從沒真的發生過」的罕見情境。19 輪裡反覆出現的流程漂移本身，就是複雜度已經開始製造新風險的證據。這套機制目前沒有壓縮審查者對實質問題的判斷空間，但明顯增加了執行者的操作與認知負擔。

**codex 的建議（advisory，這次沒有阻擋 APPROVED，留給未來處理）**：
- 先凍結目前規則，累積幾次外部主題（不是這個 skill 自我審查）的真實使用資料後，再決定要不要簡化。
- 未來另開一次簡化審查：考慮用單一 `pending_call {kind, round, k, prompt_path}` 取代目前分散的多種呼叫中狀態，把四元組壓成一個 composite audit key；但要保留使用者確認、敏感資料隔離、來源適配稽核、round cap 這些實質邊界，不是全部砍掉。

**誠實記錄**：這次審查在追蹤真實 bug 的過程中，把恢復機制越修越細，這個誠實評估等於承認——這次審查本身也示範了一次「規則累積到需要回頭問是否過度」的真實案例，不只是理論擔心。是否現在就依 codex 的建議做簡化，還是先累積使用經驗，留給使用者決定。
