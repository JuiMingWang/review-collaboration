# 圖稿來源與覆蓋對照

基準是 R13，下面程式路徑均相對於技能根目錄。圖稿是人工依來源整理的說明，沒有加入新 action、新收發政策或每輪維護機制。未標字的箭頭只省略已由前後步驟完整表示的順序，不省略授權、跨界、決策或失敗條件。

| 圖稿 | 可搜尋的節點 ID／時序 | 主要一手來源 | 已核對的內容 |
| --- | --- | --- | --- |
| 01-overview | question、host、delegate、reviewer、brief、decision | SKILL.md | 角色分工、代理隔離、精簡回報與主端採納。 |
| 02a-selection | capability、resolve、choice、sameTool、routeCheck | SKILL.md；scripts/lib/reviewer-profile.mjs；scripts/lib/acp-route.mjs | 原生能力、工具身分、預設／單次選擇、路線重驗與新 session。 |
| 02b-connection | candidate、material、initialize、inspect、login、live、saved | references/first-connection.md；references/data-boundaries.md；scripts/review-mail.mjs | 零 prompt 握手與認證、合成 live probe、資料控制、缺件停止。 |
| 03-handoff | question 至 delegate | SKILL.md 第 2–3 節；templates/background.md；templates/request.md；templates/handoff.md | 先附決策重要背景、分開閱讀與外送授權（含同議題續談）、記錄 IDs、程序版本、續談上限與代理交接。 |
| 04a-discussion | claim、lookup、hostQuestion、nextDecision、brief、followup | SKILL.md 第 3 節；templates/handoff.md | 先本機查證、具體替代案、主端問題；未結論的論點附理由送回，直到都有結論或達續談上限。 |
| 04b-adoption | brief、integrity、current、premise、decision、note | SKILL.md 第 4 節；references/mail-records.md；scripts/lib/mail-store.mjs | 逐點標明結論狀態與雙方理由，對方仍堅持的駁回在上限內送回；保留條件、前提版本、採納理由及既有觀察。 |
| 05a-send | 時序第 1–6 步 | scripts/review-mail.ps1；scripts/review-mail.mjs；scripts/lib/mail-exchange.mjs；scripts/lib/acp-client.mjs | JSON 入口、唯一 invocation、不可變封存、prompt 前 unknown、同連線回信。 |
| 05b-finalize | 時序第 7–12 步 | scripts/invoke-process.ps1；scripts/lib/ProcessTransport.cs；scripts/lib/mail-exchange.mjs；scripts/lib/mail-store.mjs | 外層清理、獨立有界 finalize、關聯收據、completion 與 reply-ready。 |
| 06-recovery | classify、recover、cancel、continuity、unknown、reconstruct | references/mail-records.md；scripts/review-mail.mjs；scripts/lib/mail-exchange.mjs；scripts/lib/mail-store.mjs | status/recover/cancel 不送 prompt；忙碌、未知不重送、原生接續或明確重建。 |
| 07-improvement | request 至 later | references/verification.md 的 Improvement proposals | 獨立觸發、當時資訊可得且可能改變判斷才歸因、不改／刪合改選項、提案帳、集中決定、基準與停止點。 |
| 08-programs | 全部元件 | scripts/review-mail.ps1；scripts/review-mail.mjs；scripts/lib/ | 主要真實程式依賴；不是完整 import 或每行呼叫圖。 |
| 09-support-and-data | records、private、source、tests、export、dist、lock、argv、native | README.md；scripts/export-clean.ps1；scripts/lib/windows-lock.mjs；scripts/lib/argv-launcher.mjs；tests/ | 資料位置、48 檔白名單、程序配套、測試與外部執行前提。 |

## 易被圖形簡化誤讀的部分

- 02b 展示一條可行的接入順序。authenticate 的獨立檢查只要求已核對入口與接入授權；它本身不以完整模型資料控制評估為前提，也不產生 live proof。圖中的資料控制檢查是送模型材料前的必要條件。
- 任一接入前置缺件均停止；圖 02b 的共同失敗框及卡片統一說明，未把相同失敗線從每個節點重複畫出。現有有效路線由 02a 直接沿用。
- 圖 04a 的「續談」終點明寫回步驟 1；主端補足背景後回步驟 2。續談持續到每個重要論點都有結論（同意、被證據說服，或雙方陳述最終立場後的分歧）或達到往返上限（預設追加 4 次）；主端或代理不同意的論點須附理由寄回。圖中只畫「達續談上限」一條停止線；需使用者決定或新資料時的停止，由「缺口未解」節點表示。
- 05a／05b 只畫正常收發順序，非正常停止與未知結果由 06 完整辨別。任何缺證據都不能補造正常回覆；相同 exchange 不因重呼叫而自動重寄。
- 08 的模組箭頭是主要分工關係。recover 由入口協調 mail-store 及必要 finalize，並非 mail-exchange 單獨完成所有恢復邏輯。共用檢查也由其他模組引用。
- 09 中測試、匯出、可選 argv launcher 都只在相關工作需要時使用。套件位置不是主端安裝註冊狀態，也不等同 reviewer 可連線；私人狀態與紀錄不能隨公開包分享。
- 改善使用 later 的真實結果只能支持、否定或保持不確定；回退仍是下一批需採用的提案。使用者沒有回報，不是成功證據。

## 來源 bytes

這份表固定圖稿所依據的來源，方便別人使用不同位置的技能副本對照。

| 相對技能根目錄的檔案 | SHA-256 |
| --- | --- |
| README.md | 6624944da7c3e00f235815dedf12477a5674cb4262afbfd882ca3a352bf23798 |
| SKILL.md | 2da33f1a8388ed76da80b93e52309c6cbf101d464aedc687f29ce7b8f6d165c5 |
| references/data-boundaries.md | bcabc0a16093206eb7b3a9b987f28478435144ad3593f5eaae7dfe127f313fc6 |
| references/first-connection.md | bd379aaa98ff9d01551fd1efdcec7f5f5fcf9bd3b40cad40ed18f9a3f918c24a |
| references/mail-records.md | 50e29d38bcf86b434791c46ac92401e9364a2b6b3b460e2fed2b4e9170f36ea2 |
| references/verification.md | c0e65b7953518b05163ffe81c0e92af4f8dfce375d74c23c6d8a21a3ec987e3f |
| scripts/export-clean.ps1 | b44fc7bc088cd4c6469d5f05692f04fae1ef7026d62ecf0fcab9a3f7f974e078 |
| scripts/invoke-process.ps1 | 2c78a98dea6a2212bde41eea6a6eef60c91a79976f4e92f7d41c86205502a4ac |
| scripts/lib/ArgvLauncher.cs | 4b1ad33f17f062827d48e142fd034e285c1dc7d4bcb399c226554ab6e8f161aa |
| scripts/lib/LockTransaction.cs | adf6852edf9092b1eaf56484232bae216b91117ce58aaa1cedaad97c7dad090e |
| scripts/lib/ProcessTransport.cs | 7166ff0322a2e8ab566f5e1543b3ed21c10af7101fc524527d2ce45434cd1d38 |
| scripts/lib/acp-client.mjs | c4d49624979c64a0e8d210e4bc705ef6405ac07349d8eca4b7a182f5391d9baf |
| scripts/lib/acp-route.mjs | 442dea258cfaa53f804eb2a3baa9b4fdb6b44816e14dc02dd611f23ed98037e3 |
| scripts/lib/argv-launcher.mjs | e7abcad64c0d9582f99561e91cdc122b14858e1eb82903ef046da6d9a66401ce |
| scripts/lib/build-argv-launcher.ps1 | a5cbe28134f8746a8627e3dd2e9fe7bbbdf71afbc407b817a9cdf42e98168382 |
| scripts/lib/build-lock-helper.ps1 | 4869f243c429ed73caf793eb548b62f4a9307590aa962e17b5101dec5a074849 |
| scripts/lib/mail-contract.mjs | 0de8ded0e752486dcd9a7f9e1a716ee669fe168df8ba095ab144030f9f5ec1ac |
| scripts/lib/mail-exchange.mjs | 9f9035986d7827fbb4f87f2859b1c948ddc37ce72d5f13675fd406a97763db93 |
| scripts/lib/mail-store.mjs | a70f6af4dac64f45c616d66027c97410f7042698ade0aebe7b78042c49e6ada5 |
| scripts/lib/reviewer-profile.mjs | 84d088e3a9a6d3c2092f401066d9a13b88daa1dac6a984a978d14ecffbfbe670 |
| scripts/lib/safe-files.mjs | 3dde4bbc837fcc58f64d0093a326d4b04157077e5e652969e2deb83c32bac763 |
| scripts/lib/windows-lock.mjs | 85395cca408399d55e037f70c3b5bc73719fc584e2741d2c8431f503c7a08408 |
| scripts/review-mail.mjs | 5fda9fce92bbc6f054ddd1eb17a7fa9a7cfd5e00b0a4917999540c8cd4639da1 |
| scripts/review-mail.ps1 | f2c319af121c6bf04d68389de400632179631b65ce521fddfa852f14e0723e8d |
| templates/background.md | 87735682b70a96ff21e7bfa162123aace3ec8b11dc6ebc6ab9e84f2f4d57d293 |
| templates/handoff.md | fee1e25cd377d70672f282ae2a49489e2821b261506d516856a724c6e372c352 |
| templates/request.md | 182ffcabe96721cb38f482b7075c2d2ead25a80ff2c07fd72e5fd4a4cf51ac26 |
