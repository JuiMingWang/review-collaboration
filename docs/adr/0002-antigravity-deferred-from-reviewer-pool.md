# 審查者暫時只用 codex，antigravity 排除在外

**Status**: accepted（預期未來會被重新評估，屆時視結果 superseded 或維持）

原先設想審查協作的審查者是 codex 與 antigravity 兩者並用，依情況挑選。實測後決定：**目前只用 codex，antigravity 暫緩納入**，作為未來選項保留，等該模型/工具成熟一些、或有明確需求時，由當時的 agent 重新驗證後再決定是否納入。

## 為什麼

實測 `agy -p --json-schema <schema> --new-project` 呼叫時，把一句語意模糊的測試 prompt 當成「要自主決定做什麼」的任務去執行——它自己判斷要建立一個 Vite 網頁專案，實際執行了 `npx create-vite`、寫檔案到磁碟（`%USERPROFILE%\.gemini\antigravity-cli\scratch\web-app-template`，11 個檔案、44.7KB，測試後已刪除），而不是單純根據 schema 回覆一個乾淨的 JSON 結果。最終 `response` 也不是一個符合我們所給 schema 的物件，`verdict` 欄位只零星出現在跟我們的 schema 無關的內部工具呼叫片段裡。同一組測試，codex 的 `--output-schema` 每次都乾淨地回傳符合 schema 的單一 JSON 物件，沒有任何非預期的副作用，成本也只有 antigravity 這次呼叫的一半不到（約 32K vs 79.5K tokens）。

使用者也另外反映，在其他場合使用 antigravity 模型時同樣遇過輸出品質不如預期的狀況——不只是這次測試的個案，兩者合在一起，判斷現階段把它排進審查協作的正式流程風險大於效益。

## 尚未證實、需要未來重新驗證時留意的部分

- 測試用的 prompt 語意模糊（"Say hello and give me a verdict number"），沒有明確禁止它使用工具；如果之後用更嚴謹限定的 review 型 prompt（明確要求「只能分析文字、不能呼叫任何工具、不能寫檔案」）測試，行為可能不同，這點目前**沒有**驗證過
- `agy --help` 顯示有 `agent`/`agents` 子指令可以列出可用的角色設定，可能存在範圍更窄、不那麼自主的角色可選，這點也**沒有**探索過
- init 事件顯示 `permission_mode: "proceed-in-sandbox"`，但依然執行了指令、寫了檔案——antigravity 的「沙盒」保證看起來比 codex 的 `--sandbox read-only` 弱，但這是從記錄反推，不是查證過的官方說明

## 重新評估時的建議起手式

未來要重新納入 antigravity 時，建議重跑本文件記錄的測試方法（impossible 數值範圍 schema + enum 誘導性 prompt 兩組測試，比較最終輸出乾淨度、有無副作用、成本），並額外測試上面列的「尚未證實」三點，而不是憑空重新設計驗證方式。
