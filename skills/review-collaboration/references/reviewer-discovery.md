# Windows reviewer 發現紀錄

查詢日：2026-09-11。此表保留當時的發現版本；後續本機驗收以各發行版的具名報告為準，不將某台電腦的成功當成讀者環境已通過。

| 工具 | Registry ID／版本 | 發行入口候選 | 上游 |
|---|---|---|---|
| Claude Code | claude-acp 0.76.0 | @agentclientprotocol/claude-agent-acp@0.76.0 | [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) |
| Codex | codex-acp 1.11.0 | @agentclientprotocol/codex-acp@1.11.0 | [codex-acp](https://github.com/agentclientprotocol/codex-acp) |
| pi | pi-acp 0.0.33 | pi-acp@0.0.33 | [pi-acp](https://github.com/svkozak/pi-acp) |
| Antigravity | antigravity-acp 1.1.1 | Windows x86_64／aarch64 的 agy_acp_server.exe | [Google 文件](https://antigravity.google/docs/ide/extensions) |

以上版本與發行方式取自 [官方 Registry JSON](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)。版本是本次查到的候選，不是「最新版永遠可用」的保證。

Node 套件需要先按明確版本準備完成，再核對 package.json 的 bin 入口並解析成 `node.exe` 加實際 entry 路徑。不能把套件名稱猜成檔名，也不能在普通送信時臨時 npx 下載。二進位發行先核對下載與解壓資料，再使用絕對 exe 路徑。

每台新環境逐條核對：實際版本與相依項、既有認證是否可用、會自動讀哪些規則／hooks／extensions、工具權限控制、model/thinking 回報、initialize 與合成 live probe。任何一項缺證據即保持未驗證，不靠工具名稱或 Registry 列名補成成功。

已核對的 Antigravity ACP 1.1.1 接入要點：initialize 宣告登入方式；Google 個人登入方法為 `oauth-personal`。若未選方法，session/new 可能在讀取登入狀態前即回 auth-required。依 [首次認證流程](first-connection.md) 設定後呼叫標準 authenticate，由官方程式管理自己的 ACP 登入；一般 `agy` CLI 自動登入不代表這一步已完成。`GEMINI_HOME` 同時控制 ACP 設定、原生登入儲存、hooks 及 skills 的位置；不能把更改此路徑當成只搬 cache，也不能複製 token。

該版本的純文字路線可使用官方 global `config/hooks.json` 的 `PreToolUse`，以 `matcher="*"` 及固定 command 回傳 `{"allowTool":false,"denyReason":"text-only review"}`，阻止模型工具讀檔／執行。hook 與設定檔應納入 runtime_files，主端須核對版本實作並做合成反例。這是原生設定資料，不是 ACP 共用核心的品牌分支；它也不是 OS 隔離或所有工具都已逐一實測的保證。來源：[Google ACP 接入文件](https://antigravity.google/docs/ide/extensions/zed/) 及該版官方發行包內 server.py、hooks.py、paths.py。
