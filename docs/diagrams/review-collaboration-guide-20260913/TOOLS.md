# 工具對照：先認識功能，再看名稱

主端與代理通常都透過 scripts/review-mail.ps1，交一個 UTF-8 JSON 請求給工具。action 是「這次請工具做哪件事」，不是另一名 agent，也不是獨立背景服務。工具入口相對安裝位置自行找到其餘模組。

| action | 做什麼 | 條件與結果 | 圖中位置 |
| --- | --- | --- | --- |
| resolve | 主端先找已保存的 reviewer 偏好與路線 | 沒有選擇就 selection-required；不送 prompt | [02a-selection](02a-selection.html)：resolve |
| authenticate | inspect 查官方登入方法；login 呼叫已核對的方法 | 零 session、零 prompt；authenticated 不等於 live proof | [02b-connection](02b-connection.html)：inspect、login |
| probe | initialize 握手；live 用固定合成材料檢查回信 | initialize 零 prompt；live 有授權與完整收據才保存驗證 | [02b-connection](02b-connection.html)：initialize、live |
| profile-set | 永久更新此主工具的 reviewer 預設 | 需 expected_revision；單次覆寫不改它 | [02a-selection](02a-selection.html)：選擇保存與設定卡片 |
| project-init | 建立／核對該專案的私人紀錄根目錄 | 資料不在 skill 套件內 | [03-handoff](03-handoff.html)：project |
| topic-create | 不同決策建立議題，必要時連回相關議題 | 同一決策可沿用 topic | [03-handoff](03-handoff.html)：topic |
| run-open | 保存本輪 host key、reviewer、route、設定與期限 | 不同 host session 新 run；進行中的 run 不跟隨偏好改變 | [03-handoff](03-handoff.html)：run |
| exchange | 封存一封已授權的信、送一次、收回並核對 | 相同 exchange 重呼叫只核對原狀態 | [05a-send](05a-send.html)：時序 1–6 |
| status | 讀 run／exchange 狀態與完成證據 | 不送 prompt；reply-ready 不代表內容正確 | [06-recovery](06-recovery.html)：status、result |
| cancel | 寫入取消要求 | 不送新 prompt；marker 不等於對方已停止 | [06-recovery](06-recovery.html)：cancel、stopped |
| recover | 核對原呼叫、鎖與收據，必要時補 finalize | 不送 prompt、不重寄；仍缺證據就保留未知 | [06-recovery](06-recovery.html)：recover、unknown |
| note | 保存採納或其他主端紀錄；前提變化增加版本 | 只有 premise-change 增 topic revision；舊回信需重評 | [04b-adoption](04b-adoption.html)：premise、note |

## 程式與輔助工具

| 檔案 | 實際功能 | 圖稿 |
| --- | --- | --- |
| scripts/review-mail.ps1 | 保存原呼叫、交給有期限的程序、等待清理及必要 finalize。 | 05a／05b／08 |
| scripts/review-mail.mjs | 驗證 JSON，分派以上 12 個 action；核對工具身分與本輪設定。 | 08 |
| scripts/invoke-process.ps1；lib/ProcessTransport.cs | 將子程序納入 Windows Job，處理期限、輸出、原生 exit 與程序樹清理收據。 | 08 |
| lib/reviewer-profile.mjs | 正規化工具別名、拒絕同工具、預設與單次選擇、revision 比對。 | 08 |
| lib/acp-route.mjs | 官方條目發現、本機候選、路線 fingerprint、資料控制與 probe 證據。 | 02b／08 |
| lib/acp-client.mjs | ACP initialize、authenticate、session/new 或 load、prompt 串流、取消與停止結果。 | 05a／08 |
| lib/mail-exchange.mjs | 封信、單次送信、status/cancel、回信和程序收據關聯、finalize。 | 05a／05b／08 |
| lib/mail-store.mjs | 專案、議題、run、exchange、狀態、notes、版本、恢復與短鎖。 | 08 |
| lib/mail-contract.mjs；lib/safe-files.mjs | ID、UTF-8、欄位與 hash 契約，普通本機路徑及私人資料防護。 | 08 |
| lib/windows-lock.mjs；lib/build-lock-helper.ps1；lib/LockTransaction.cs | 編譯並使用原子短鎖；避免多個 writer 同時覆寫。 | 09 |
| lib/argv-launcher.mjs；lib/build-argv-launcher.ps1；lib/ArgvLauncher.cs | adapter 只能接受 executable 時，按明確 argv 啟動真正 CLI；轉送串流與 exit。 | 09 |
| tests/run-offline.mjs；tests/run-windows.ps1 | 按需驗證機械契約與 Windows 程序行為；不證明真人任務中的 reviewer 品質。 | 09 |
| scripts/export-clean.ps1 | 以個別白名單輸出乾淨資料夾及 manifest，不執行上傳／發布。 | 09 |

此表的 lib 指 scripts/lib。個別 .test.mjs 與 tests/fixtures 是兩個測試入口使用的測試材料，不是普通審查額外執行的工具。圖 09 也區分 _private、本機專案紀錄與公開副本。
