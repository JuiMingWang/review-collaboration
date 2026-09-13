# 首次設定 reviewer

## 先判定哪一端缺能力

| 情況 | 處理 |
| --- | --- |
| 主 agent 沒有 ACP server | 可用包內工具作為 ACP client；不必替主 agent 安裝 ACP。主端仍須能讀 skill、呼叫本機工具，完整流程另須具備原生 subagent。 |
| reviewer 原生提供 ACP | 核對該版本的 ACP 啟動入口、登入與資料控制，再做握手及合成回信驗證。 |
| reviewer CLI 沒有 ACP，但有上游 adapter | 核對 adapter 與 CLI 的相容版本。安裝是獨立步驟；既有 CLI 登入不保證 adapter 共用登入。 |
| reviewer 沒有可核對的 ACP 入口／adapter | 保留草稿並說明缺件，停止投遞。請使用者選擇安裝已核對 adapter 或明確更換 reviewer；不自動改用終端模擬、Herdr、MCP 或另一模型。 |
| 握手通過但登入失效／未登入 | 主 agent 用 authenticate inspect 取得官方宣告的方法，再核對並設定登入方式、呼叫 login。需要本人操作時，由使用者完成官方瀏覽器授權。不要要求貼 token、複製認證或以新信件 ID 掩蓋投遞未知。 |

ACP 的 client/server 是通訊角色，與 host/reviewer 的討論角色不同。回信走原 ACP 連線，不需要 reviewer 反向連上主 agent 的 ACP server。換成另一個未列名 agent 時，新增身分與路線資料，沿用同一套工具；仍須核對 Windows 入口、协议版本、正常回合結束、登入與資料控制，不能僅憑「支援 ACP」宣稱相容。

登入錯誤也可能受執行環境影響。先區分本機 cache／信任鎖／原生登入更新所需權限與帳號狀態；在既有授權內做有界診斷，保留原失敗與新證據。受限環境回報 token 過期，不足以證明使用者必須重新登入。不要以此為由關閉安全功能，或自動重送投遞未知的信件。

先確定主工具與 reviewer 的工具身分。模型名稱不能當工具身分；常見別名會正規化，同工具自審會被拒絕。未知工具先保存 canonical identity、別名及固定上游證據，再建立路線。每個 host 只保存一筆預設；單次覆寫不改預設。

1. 先解析已保存的本機 route。沒有時，查官方 Registry 的指定條目，保存其版本、來源及 digest。Registry 是發現資料，不是可直接執行的 shell 指令。
2. 核對本機入口。路線只接受絕對 `.exe` 與分開的 arguments；Node adapter 使用 `node.exe` 加絕對 entry script。缺套件就回報缺件，不自動 npx 下載，不修改 PATH 或認證。
3. 核對啟動時自動載入與工具讀取範圍。將評估寫成私人 material-control 證據，綁定 route fingerprint；`status=verified` 文字本身不足以啟動。詳見 [資料界線](data-boundaries.md)。
4. initialize 只證明握手，不送 prompt。需要認證時先完成下節流程；合成 live probe 才檢查正常回信。外層程序與保存證據也必須完成，才更新 route 的驗證層級。
5. 保存 route JSON 與短 MD，再以 profile 的 expected revision 更新該 host。另一個 writer 已修改時回 revision mismatch，不覆蓋其選擇。

正常使用只讀該 host 與選定路線。入口 bytes、package metadata、明列 runtime_files、argv、source 或設定映射變動時要求重驗。fingerprint 並非整棵依賴樹安全證明；升級依賴須更新來源版本與必要的 runtime_files。

需要 adapter 啟動控制時，route 可保存 `launch.environment`（字串值覆寫、null 移除該子程序的環境變數）及 `session_meta`（送到 ACP session/new 或 session/load 的 `_meta`）。兩者都納入 fingerprint；核心只傳遞資料，不依工具品牌分支。這些欄位只放非秘密設定，不放 API key、token 或認證內容；環境變數名稱的拒絕規則只是防呆，不能辨識任意字串是否秘密。metadata 的實際作用須由該版本 adapter 的文件／原始碼及合成測試核對。未提供 filesystem capability 或空 cwd，都不能替代這項核對。

沒有 model/thinking 指定時，不送 setter；actual 未回報就顯示 unknown。明確指定時一定要有 route.configuration 的 intent/api/id/evidence_ref 映射；category 可用於觀察回報，不能單靠它發 setter。先設 model，再重新讀 thinking 選項；不把各工具的 high/low 當作等價。

## 認證：主 agent 準備，使用者只做本人授權

CLI 的互動登入與 ACP 登入可能使用不同設定或儲存。`reviewer-auth-required` 不足以區分「未選登入方式」與「帳號需重新授權」。主 agent 應先檢查已釘選版本的文件／實作，不能請使用者猜旗標或尋找 token。

1. 使用同一 PowerShell 入口，送 action=`authenticate`，args 為 `route_candidate_file`、`mode=inspect`、`authorization_ref`。只握手，返回有界的 method id/name/type；不建立 session、不送 prompt。此步只要求已核對入口及使用者的接入授權，尚不要求模型資料控制證據。
2. 核對使用者的登入種類。若有歧義才詢問；不要自動挑第一項。候選 route 增加 `authentication:{"method_id":"官方宣告的 ID"}`，以 `fingerprintRoute` 重算並保存。這是非秘密選擇，不是 token；任何方法變更都使既有路線證據失效。
3. 呼叫同一 action，`mode=login`。只對恰好匹配且 type 為 `agent`（省略時同義）的方法發標準 `authenticate({methodId})`。官方 agent 自行重用登入、開啟瀏覽器及保存認證；使用者只需完成它要求的本人操作。無需額外開 CLI 找設定。
4. 核對 mail-result 的成功、原生 exit 與清理收據。`authenticated` 只代表官方認證請求完成且零 prompt；不等於 live-verified，也不改預設 reviewer。完成資料控制評估後，再跑合成 live probe。

login 最多等待五分鐘，inspect 最多二十秒，外層可用 `-TimeoutMs` 設更短期限。工具保存 auth-submission/auth-outcome，不保存憑證或原始診斷；逾時為 unconfirmed，因官方可能已完成登入。不要自動重試或切換方法。若方法 type=`terminal`，明確回 authentication-terminal-required；目前 client 不宣告 terminal auth 能力，保留官方人工登入／已核對啟動路線，不能假裝已支援。

route 有 authentication 時，普通回合會依序 initialize → authenticate → session/new 或 session/load → prompt。無此欄位的既有路線保持原行為；不擅自添加登入。回信沿原連線返回。這套步驟依 ACP 資料運作，核心不按品牌分支。方法清單和相同 ACP 協議仍不能取代個別版本的登入、啟動載入及工具範圍核對。

來源：[ACP 認證協議](https://agentclientprotocol.com/protocol/v1/authentication)。

## 首次建檔介面

設定階段從 skill 的絕對位置載入 `scripts/lib/acp-route.mjs`（Node ESM）。`fetchRegistryEntry(registryId)` 只查指定条目；`candidateFromRegistry(selected, {executable, arguments}, reviewerToolId)` 在解析本機入口後產生候選。補齊 configuration 與來源，再用 `fingerprintRoute(candidate)` 更新 fingerprint，JSON 保存於 `_private`。

material assessment JSON 必須有 schema_version=1、route_fingerprint、scope=text-and-listed-snapshots、startup_control、tool_control、sources（HTTPS），及 synthetic_only=true（用於初次合成 probe）。內容描述實際核對過的控制；候選 material_control.evidence_ref 指向該檔，evidence_sha256 為實際 bytes 的 SHA-256。選定 reviewer 不等於完成這份評估。

接著用公開 probe action（initialize，再 live）傳入 route_candidate_file、mode、authorization_ref；只有工具取得完整收據才保存驗證路線。不能自行製造 live proof，也不能使用合成 endpoint 的評估來認證真實 agent。

live probe 的預設內層期限為120秒，包含啟動、認證、取得模型及回覆；外層 wrapper 仍有獨立期限。初始化慢於30秒不等於登入失敗。若結果顯示 prompts_submitted=0，應定位尚未完成的啟動階段；已送出但狀態未知時不可自動重送。

profile-set 的 selection 必須有 host_id、reviewer_tool_id、route_id、model、thinking。新 profile 的 expected_revision=0；既有 profile 先 resolve 取得 revision。自訂工具可透過 `reviewer-profile.mjs` 的 `saveIdentity(privateRoot, record)` 保存 schema_version=1、canonical_id、aliases、source_url、source_revision、evidence；不要把模型名稱當工具身分。

首次自動排查只允許一個候選與一次有依據的修正。仍失敗則保存錯誤，另開排查；不偷換 reviewer、模型或協議。舊 schema-1 只讀為候選，不搬原生 session，不把 cli/mcp 當已驗證 ACP。

live probe 在 prompt 送出前保存 `probe-submission.json`（delivery=unknown），回合返回後保存 `probe-outcome.json` 的投遞數、停止原因、正常化錯誤及已回報設定。失敗也保留，只有成功且外層收據完整才產生 probe-proof。沒有 outcome 而已有 submission 時，不可推論未送出並直接重試。診斷檔不保存原始帳號標籤／stderr；需深入診斷时另開有界且明確範圍的工作。

## Adapter 只接受 executable，但原生 CLI 需要額外 argv

可用 `node <skill>/scripts/lib/argv-launcher.mjs` 建立通用原生啟動工具，返回包內 `_private/runtime` 的 executable。將 adapter 的 executable 設定指向它；route 的 environment 設 `REVIEW_LAUNCH_TARGET` 為實際 `.exe` 絕對路徑，`REVIEW_LAUNCH_ARGV` 為 JSON 字串陣列（前置參數）。Adapter 追加的參數接在其後。沒有 shell 展開，也不替任何品牌猜參數；資料控制、實际 CLI flags 與 adapter 入口仍需核對。

例如 Node CLI 的前置陣列是 `["<absolute-cli.js>","<documented-option>"]`，目標為 `node.exe`。route.runtime_files 必須另釘選真正 CLI entry、啟動工具及相關設定實作；只釘選 launcher 不能偵測目標 CLI 升級。launcher 只轉送 stdin/stdout/stderr 與 exit code，程序樹的期限／清理由外層 Windows Job 負責，不能當独立的程序樹管理器。

來源：[Registry 使用說明](https://github.com/agentclientprotocol/registry/blob/main/README.md)、[Registry 格式](https://github.com/agentclientprotocol/registry/blob/main/FORMAT.md)。目錄列名不等於本機登入或資料控制已通過。
