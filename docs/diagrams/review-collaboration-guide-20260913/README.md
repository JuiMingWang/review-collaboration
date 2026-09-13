# Review collaboration｜給第一次接觸者的圖解

[English](en/README.md) · [英文導覽頁](en/index.html)

這個 Windows skill 用來請另一種 agent 工具審查想法、方案、成果或爭議。你目前對話的 agent 是**主端**，它派自己的原生 **subagent（代理）**與外部 **reviewer（審查者）**深入討論；主端保留決策需要的結果、理由、支持證據及條件，完整信件留在專案紀錄。

開始閱讀：[可點選的圖解導覽頁](index.html)。每張 HTML 都可獨立開啟、縮放及切換明暗；PNG 用於 GitHub 預覽；同名 JSON 是可維護的 Archify 圖稿。不要把縮圖當成唯一閱讀尺寸。

![整套協作總覽](01-overview.png)

## 怎麼讀這 12 張圖

保留全貌、Agent 接入、審查流程、持續改善四個主題，再附工具分工。圖中數字是該張的步驟順序，箭頭寫繼續或分支的條件；卡片補充共同失敗條件和停止界線。05a／05b 是同一封正常信件的連續時序，並非兩輪 reviewer 問答。

| 主題 | 開啟圖稿 | 這張回答什麼 | 靜態圖 |
| --- | --- | --- | --- |
| A｜全貌 | [整套協作在做什麼](01-overview.html) | 從使用者問題，到代理詳談、主端採納；先認識四個角色。 | [PNG](01-overview.png) |
| B｜Agent 接入 | [確認能力與選 reviewer](02a-selection.html) | 有沒有原生 subagent？是否同工具自審？已有路線能否沿用？ | [PNG](02a-selection.png) |
| B｜Agent 接入 | [首次接入與必要重驗](02b-connection.html) | 核對入口、資料範圍、握手、登入、合成回信；各自代表不同證據。 | [PNG](02b-connection.png) |
| C｜審查流程 | [準備送審與交接](03-handoff.html) | 寫什麼材料、哪些可外送，如何建立 project、topic、run 並派代理。 | [PNG](03-handoff.png) |
| C｜審查流程 | [代理查證、追問與停止](04a-discussion.html) | 先本機查證；只為會改變選擇的缺口續談，必要才合併回問主端。 | [PNG](04a-discussion.png) |
| C｜審查流程 | [主端核對與採納](04b-adoption.html) | 保留理由、條件、證據與分歧；前提變更須重評，最後保存 adoption。 | [PNG](04b-adoption.png) |
| C｜審查流程 | [程式如何寄信與收回文字](05a-send.html) | 第 1–6 步：JSON 入口、封存、送出前標記 unknown、ACP 串流回覆。 | [PNG](05a-send.png) |
| C｜審查流程 | [程式如何確認完成](05b-finalize.html) | 第 7–12 步：先清理程序，再關聯原證據；reply-ready 尚未代表採納。 | [PNG](05b-finalize.png) |
| C｜審查流程 | [異常、取消與上下文接續](06-recovery.html) | status、recover、cancel 的差別；投遞未知不重送，原生 session 失效要明確重建。 | [PNG](06-recovery.png) |
| D｜持續改善 | [有證據才提出改善](07-improvement.html) | 使用者另外要求時整理提案，可不改、刪除、合併或改寫；集中採用並有停止點。 | [PNG](07-improvement.png) |
| 配套｜工具與檔案 | [程式模組的功能與關係](08-programs.html) | 從 PowerShell 入口到 Node 分派、信件層、ACP client、紀錄與防護。 | [PNG](08-programs.png) |
| 配套｜工具與檔案 | [配套工具與資料放哪裡](09-support-and-data.html) | 原子鎖、可選 argv 啟動器、測試、匯出，以及私有紀錄與公開副本的區別。 | [PNG](09-support-and-data.png) |

第一次讀：01 → 02a → 必要時 02b → 03 → 04a → 04b。要理解收發可靠性再讀 05a → 05b → 06；想改善 skill 看 07；想理解每個程式或分享範圍看 08 → 09。詳細的 [12 個 action 與程式工具對照](TOOLS.md) 可配合圖稿查找。

## 必須先知道的界線

- 「原生 subagent」是真正由主工具派出的代理，有自己的工作上下文。工具不會把一段角色描述當成代理。主端不需要 ACP server；包內程式就是 ACP client。
- reviewer 必須是另一種工具。同工具換不同模型仍是同工具自審。使用者選 reviewer 不等於允許把整段對話或所有本機資料外送。
- ACP 是收發協議：信件與回信走同一連線。正文、停止原因、程序清理與關聯證據各自核對；reply-ready 只代表這些證據完整，不保證答案正確。
- 普通審查不額外分析整輪效果，只順手保存已見的有用觀察。使用者另行要求維護，才整理具體改善提案；採用後才改 skill，不會背景自我改寫。
- 技能自有檔案集中在套件裡；Windows、Node、.NET Framework、主端原生代理能力與 reviewer 安裝／登入／路線核對，仍是外部環境前提。圖稿不是已完成所有 agent 接入的證明。

## 來源與交付範圍

圖稿對照 R11 現行原始文件與程式，不新增技能行為。詳見 [來源與覆蓋對照](SOURCE-MAP.md)、[驗證摘要](VALIDATION.md)。流程箭頭是程序說明，不能用圖稿檢查通過來證明真實審查品質或零資訊流失。

作者文字為繁體中文。Archify 2.17 的固定 Viewer UI 與 HTML lang 回退為英文；部分通用圖例也沿用 renderer 的用語。圖稿包含 [Archify 授權](ARCHIFY-LICENSE.txt)。原始 visual-check 收據保存在專案的本機 evidence 工作包，未納入公開圖包。
