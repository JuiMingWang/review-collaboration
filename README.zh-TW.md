# review-collaboration

*[English](./README.md)*

一個 [Claude Code](https://claude.com/claude-code) 技能（skill）：在你跟 Claude 定案一個結論之前，先把它拿去給一個**獨立的 AI 審查者**（目前是 [Codex CLI](https://github.com/openai/codex)）挑毛病——是真正不同視角的第二意見，不是橡皮圖章。

## 為什麼需要這個

Claude 有可能自信滿滿地講錯，而且錯得很難從同一段產生這個結論的對話裡發現——盲點常常是討論本身的框架，不是某一個具體的事實錯誤。這個技能會把討論整理成一份中性化摘要，交給另一家公司、不同模型的 AI，跑一套結構化、可多輪來回的協商流程：審查者提出異議，Claude 修正或提出反駁理由，如此反覆，直到審查者不再提出新的、沒被說服放棄的異議——或是輪數到達上限，交回給你決定怎麼走下去。

## 這個技能實際上做了什麼

- 在內容離開對話之前，先把討論**匿名化**成一份中性的審查包（不含來源歸屬、不會整份逐字稿丟過去）。
- 強制每一項假設都要標註明確的**查證狀態**（已查證／可查證但未查證／純屬判斷）——審查者的工作也包含稽核「這些標籤本身」有沒有標錯，不是只看結論對不對。
- 整個來回協商流程，是透過一支小型的 **PowerShell CLI ＋ JSON schema 狀態機**（`scripts/review-collab.ps1`）在跑，進度不怕 session 中斷，不是靠散文手動追蹤。
- 每次呼叫審查者，都是從一個隔離、用完即丟的工作目錄執行——這個專案曾經直接觀察到，審查者拿到一段容易誤解的提示時，會自己跑去讀取不相關的檔案，所以它從來不會在你真正的專案資料夾裡執行。
- 到達輪數／補件次數上限時會停下來、把決定權交還給**你**，不會為了結束迴圈就默默宣稱達成共識。

## 什麼時候該用

你正在用 Claude Code，你跟 Claude 剛討論出一個有點份量的結論（設計決策、架構選擇、計畫），你想在真正定案前找一個真正獨立的第二意見——而不是同一個模型換句話說再講一次。

**不適用於**：審查一份已經存在、沒有現場討論背景的檔案／規格文件（那是另一種工具該做的事）——這個技能審查的是「一段對話得出的結論」。

## 系統需求

- Windows、PowerShell 5.1（這份程式碼裡所有編碼／參數綁定相關的變通寫法，都是針對這個版本特別寫的）。
- 已安裝並登入的 [Codex CLI](https://github.com/openai/codex)（在一個全新的 shell 裡執行 `codex --version` 應該要能正常運作）。
- Claude Code。

## 安裝

```powershell
git clone https://github.com/JuiMingWang/review-collaboration.git "$env:USERPROFILE\.claude\skills\review-collaboration"
```

就這樣——腳本、schema、測試全部跟 `SKILL.md` 放在同一個 repo 裡，不用另外設定任何東西。

## 使用方式

在 Claude Code 的對話裡，只要你跟 Claude 討論出一個值得找第二意見的結論，直接明確地開口要求即可——例如「用 review-collaboration 幫我審查一下這個」。這個技能不會自己主動觸發（`SKILL.md` frontmatter 裡設定了 `disable-model-invocation: true`）——一定要你親口要求才會執行。

## 目前狀態

- 已對真實 Codex CLI 完成一次端到端驗證，含工作目錄隔離機制本身確實有效（透過審查者自己留下的 log，確認它嘗試探索檔案系統的行為被擋下來）。
- 早期、使用次數還不多——目標專案自己的 `docs/review-log.md` 會隨實際使用逐漸累積紀錄；目前請把這個技能的結論當作「一份有結構的第二意見」，還不是一個已經被大量實戰驗證過校準準確度的工具（詳見 `SKILL.md` 開頭的「Known limitation」說明）。
- 每個機制背後的設計理由都記錄在 [`CONTEXT.md`](./CONTEXT.md) 與 [`docs/adr/`](./docs/adr/) 裡——如果 `SKILL.md` 裡有什麼規則看起來沒道理，答案通常在這裡。

## 貢獻

這是一個早期、個人維護的專案——歡迎 issue 與 PR（尤其是實際使用回報、輪數上限／補件上限邏輯處理不好的邊界案例，或是把這套 PowerShell 邏輯移植到 Linux／macOS 上）。

## 授權

MIT — 詳見 [LICENSE](./LICENSE)。
