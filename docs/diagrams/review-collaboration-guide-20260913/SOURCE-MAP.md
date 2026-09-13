# 圖稿來源與覆蓋對照

基準是 R11，下面程式路徑均相對於技能根目錄。圖稿是人工依來源整理的說明，沒有加入新 action、新收發政策或每輪維護機制。未標字的箭頭只省略已由前後步驟完整表示的順序，不省略授權、跨界、決策或失敗條件。

| 圖稿 | 可搜尋的節點 ID／時序 | 主要一手來源 | 已核對的內容 |
| --- | --- | --- | --- |
| 01-overview | question、host、delegate、reviewer、brief、decision | SKILL.md | 角色分工、代理隔離、精簡回報與主端採納。 |
| 02a-selection | capability、resolve、choice、sameTool、routeCheck | SKILL.md；scripts/lib/reviewer-profile.mjs；scripts/lib/acp-route.mjs | 原生能力、工具身分、預設／單次選擇、路線重驗與新 session。 |
| 02b-connection | candidate、material、initialize、inspect、login、live、saved | references/first-connection.md；references/data-boundaries.md；scripts/review-mail.mjs | 零 prompt 握手與認證、合成 live probe、資料控制、缺件停止。 |
| 03-handoff | question 至 delegate | SKILL.md 第 2–3 節；templates/background.md；templates/request.md；templates/handoff.md | 先附決策重要背景、分開閱讀與外送授權、記錄 IDs、程序版本與代理交接。 |
| 04a-discussion | claim、lookup、hostQuestion、nextDecision、brief、followup | SKILL.md 第 3 節；templates/handoff.md | 先本機查證、具體替代案、主端問題、續談價值與預算停止。 |
| 04b-adoption | brief、integrity、current、premise、decision、note | SKILL.md 第 4 節；references/mail-records.md；scripts/lib/mail-store.mjs | 逐項交代重要問題或明示未解；保留條件、前提版本、採納理由及既有觀察。 |
| 05a-send | 時序第 1–6 步 | scripts/review-mail.ps1；scripts/review-mail.mjs；scripts/lib/mail-exchange.mjs；scripts/lib/acp-client.mjs | JSON 入口、唯一 invocation、不可變封存、prompt 前 unknown、同連線回信。 |
| 05b-finalize | 時序第 7–12 步 | scripts/invoke-process.ps1；scripts/lib/ProcessTransport.cs；scripts/lib/mail-exchange.mjs；scripts/lib/mail-store.mjs | 外層清理、獨立有界 finalize、關聯收據、completion 與 reply-ready。 |
| 06-recovery | classify、recover、cancel、continuity、unknown、reconstruct | references/mail-records.md；scripts/review-mail.mjs；scripts/lib/mail-exchange.mjs；scripts/lib/mail-store.mjs | status/recover/cancel 不送 prompt；忙碌、未知不重送、原生接續或明確重建。 |
| 07-improvement | request 至 later | references/verification.md 的 Improvement proposals | 獨立觸發、當時資訊可得且可能改變判斷才歸因、不改／刪合改選項、提案帳、集中決定、基準與停止點。 |
| 08-programs | 全部元件 | scripts/review-mail.ps1；scripts/review-mail.mjs；scripts/lib/ | 主要真實程式依賴；不是完整 import 或每行呼叫圖。 |
| 09-support-and-data | records、private、source、tests、export、dist、lock、argv、native | README.md；scripts/export-clean.ps1；scripts/lib/windows-lock.mjs；scripts/lib/argv-launcher.mjs；tests/ | 資料位置、48 檔白名單、程序配套、測試與外部執行前提。 |

## 易被圖形簡化誤讀的部分

- 02b 展示一條可行的接入順序。authenticate 的獨立檢查只要求已核對入口與接入授權；它本身不以完整模型資料控制評估為前提，也不產生 live proof。圖中的資料控制檢查是送模型材料前的必要條件。
- 任一接入前置缺件均停止；圖 02b 的共同失敗框及卡片統一說明，未把相同失敗線從每個節點重複畫出。現有有效路線由 02a 直接沿用。
- 圖 04a 的「續談」終點明寫回步驟 1；主端補足背景後回步驟 2。這些是可選分支，沒有固定 reviewer 輪數，也不要求同意。
- 05a／05b 只畫正常收發順序，非正常停止與未知結果由 06 完整辨別。任何缺證據都不能補造正常回覆；相同 exchange 不因重呼叫而自動重寄。
- 08 的模組箭頭是主要分工關係。recover 由入口協調 mail-store 及必要 finalize，並非 mail-exchange 單獨完成所有恢復邏輯。共用檢查也由其他模組引用。
- 09 中測試、匯出、可選 argv launcher 都只在相關工作需要時使用。套件位置不是主端安裝註冊狀態，也不等同 reviewer 可連線；私人狀態與紀錄不能隨公開包分享。
- 改善使用 later 的真實結果只能支持、否定或保持不確定；回退仍是下一批需採用的提案。使用者沒有回報，不是成功證據。

## 來源 bytes

這份表固定圖稿所依據的來源，方便別人使用不同位置的技能副本對照。

| 相對技能根目錄的檔案 | SHA-256 |
| --- | --- |
| README.md | 0c39ebf676d2815cb42158b23ab554f2f099ccfe71b35c571d9e1489f10d722c |
| SKILL.md | 48f0949ec95caf66e48cffad5eeaa3031ae2a00f60d7afdd2db5779fee6a3d0a |
| references/data-boundaries.md | bcabc0a16093206eb7b3a9b987f28478435144ad3593f5eaae7dfe127f313fc6 |
| references/first-connection.md | bd379aaa98ff9d01551fd1efdcec7f5f5fcf9bd3b40cad40ed18f9a3f918c24a |
| references/mail-records.md | 2d95953758c80f1ae8cc892a6e6f6612f367ea19350073f1de780df3f72c319f |
| references/verification.md | c0e65b7953518b05163ffe81c0e92af4f8dfce375d74c23c6d8a21a3ec987e3f |
| scripts/export-clean.ps1 | 34a9033ac0ec75b65e69b15e8643d2bfacd1cac704154985dc69ba7855ce7e6c |
| scripts/invoke-process.ps1 | 2c78a98dea6a2212bde41eea6a6eef60c91a79976f4e92f7d41c86205502a4ac |
| scripts/lib/ArgvLauncher.cs | 4b1ad33f17f062827d48e142fd034e285c1dc7d4bcb399c226554ab6e8f161aa |
| scripts/lib/LockTransaction.cs | adf6852edf9092b1eaf56484232bae216b91117ce58aaa1cedaad97c7dad090e |
| scripts/lib/ProcessTransport.cs | 7166ff0322a2e8ab566f5e1543b3ed21c10af7101fc524527d2ce45434cd1d38 |
| scripts/lib/acp-client.mjs | c4d49624979c64a0e8d210e4bc705ef6405ac07349d8eca4b7a182f5391d9baf |
| scripts/lib/acp-route.mjs | 442dea258cfaa53f804eb2a3baa9b4fdb6b44816e14dc02dd611f23ed98037e3 |
| scripts/lib/argv-launcher.mjs | 5ed5fe429b15b3cdc74b0b755704a9c512ac01f7b0926aac94a09c69792b0e97 |
| scripts/lib/build-argv-launcher.ps1 | e3e98de837489e53e7e1eaf891e45b081ee25cd8010da8cb1d385daa7d2feefa |
| scripts/lib/build-lock-helper.ps1 | c036deed2a94f4bdc340a375ec997ef281a0e7c8375d5ef9bed22a3f8adf5445 |
| scripts/lib/mail-contract.mjs | 0de8ded0e752486dcd9a7f9e1a716ee669fe168df8ba095ab144030f9f5ec1ac |
| scripts/lib/mail-exchange.mjs | 9f9035986d7827fbb4f87f2859b1c948ddc37ce72d5f13675fd406a97763db93 |
| scripts/lib/mail-store.mjs | a70f6af4dac64f45c616d66027c97410f7042698ade0aebe7b78042c49e6ada5 |
| scripts/lib/reviewer-profile.mjs | 84d088e3a9a6d3c2092f401066d9a13b88daa1dac6a984a978d14ecffbfbe670 |
| scripts/lib/safe-files.mjs | 3dde4bbc837fcc58f64d0093a326d4b04157077e5e652969e2deb83c32bac763 |
| scripts/lib/windows-lock.mjs | b9246c6a2af1f455bdb241d5f53bd9be7fb572253bd455e7fc63349c5b7d489d |
| scripts/review-mail.mjs | 5fda9fce92bbc6f054ddd1eb17a7fa9a7cfd5e00b0a4917999540c8cd4639da1 |
| scripts/review-mail.ps1 | f2c319af121c6bf04d68389de400632179631b65ce521fddfa852f14e0723e8d |
| templates/background.md | 87735682b70a96ff21e7bfa162123aace3ec8b11dc6ebc6ab9e84f2f4d57d293 |
| templates/handoff.md | 5dfbca847fb77f8a1fae76213987887d3101c2da18d663378e918fe590f19f3f |
| templates/request.md | 8c7815a8e5976ed8792955df4627862e59e6086817d025a41c73d3bbaabbe7ae |
