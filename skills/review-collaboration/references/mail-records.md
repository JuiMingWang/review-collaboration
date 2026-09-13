# 信件紀錄與工具呼叫

本頁描述機械收發介面。四角色如何整理議題、派 subagent 及主端驗收，見 [skill 主文](../SKILL.md)。工具不判斷誰的方案較好，也不自動採納回信。

## 儲存位置

專案的 `.review-collaboration/` 保存 project.json、index.md、各 topic 的 topic.json 與 notes，以及各 run 的 run.json 和 exchanges。ID 都是 UUID。不同主 session 可讀同專案紀錄；每個新 run 保存當次 host、reviewer、route、model/thinking 與時限快照，不依 profile 後續改動重新解讀舊信。

每個 exchange 依序保存：

1. `request.md`、`outbound.json`、`input.json`、attachments/hash：原信及實際準備送出的文字快照。input 包含四 ID、previous_exchange_id、topic revision、授權來源及 hash。
2. `dispatch.json`：唯一原呼叫的 invocation、輸入與程序收據位置。送出 prompt **之前**，state 先寫 delivery=unknown。
3. `reply.md.partial`：串流中途的正文；正常收到停止訊息後保存 `reply.md` 及 `agent-result.json`。沒有停止訊息不能憑部分文字補造完成回信。
4. `transport/receipt.json`、`completion.json`：外層 Windows Job 清理完成後，由另一個有時限的 finalize 程序發布。completion 綁定 input、reply 與 receipt hash；讀取時重新核對。

`reply-ready` 表示收發證據支持正常回信，semantic_acceptance 仍是 pending。其他 status 為 incomplete、refused、cancelled、failed、unconfirmed；delivery 另為 not-sent、unknown、replied。收到拒絕或取消的停止原因仍原樣保留；附帶錯誤須一起閱讀。

已保存 agent-result、但外層收據尚未完成時，status 保持 unconfirmed。投遞未知時不自動重送。相同 exchange 再呼叫只比較既有封存並回報狀態；改信、改授權或改 continuity 都需要新 exchange。取消只寫相關 marker；收到 marker 不等於 reviewer 已取消。

## 呼叫入口

從任意 cwd，以 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <skill>/scripts/review-mail.ps1 -RequestFile <absolute-envelope.json>` 呼叫。工具安裝位置由 script 自身解析。OutputDirectory 省略時寫入包內 `_private/operations/<UUID>`；指定時必須是未存在的本機普通路徑。每次會保留原始 transport request、invocation metadata 及 mail-result.json。

請求是 UTF-8 JSON：`{"schema_version":1,"action":"...","args":{...}}`。操作專案紀錄時另有絕對 `record_root`。未知 action／欄位被拒絕。所有路徑、文字、argv 都當資料傳遞，不拼 shell 指令。

| action | args | 效果 |
|---|---|---|
| resolve | host_id | 只讀該 host 選擇；沒有則 selection-required |
| authenticate | route_candidate_file, mode, authorization_ref | inspect 取得非秘密登入方法；login 交由官方 agent 認證；兩者零 session／零 prompt，不產生 live proof |
| probe | route_candidate_file, mode, authorization_ref | initialize 不送 prompt；live 僅送固定合成連線題，須已有資料控制證據 |
| profile-set | selection, expected_revision | CAS 更新 host 預設；revision 不符不覆寫 |
| project-init | project_root | 建立／核對專案紀錄及私人資料防護 |
| topic-create | title, related_topic_ids（可省略） | 新議題；關係由主 agent 判斷 |
| run-open | topic_id, host_id, host_session_key；可選 selection_override, timeout_ms | 保存本次設定快照；host key 須可追溯，不猜原生 session |
| exchange | run_id, exchange_id, request_file, input_file | 封存、送一次、收信、完成核對 |
| status | run_id；可選 exchange_id | 只讀，不送 prompt |
| cancel | run_id, exchange_id | 寫取消要求，不送新 prompt |
| recover | run_id, exchange_id | 核對死鎖與原呼叫證據；必要時補 finalize，不送 prompt |
| note | run_id, kind, note_file, expected_topic_revision | 新寫主端紀錄；只有 premise-change 增前提版本 |

selection 的 model/thinking 各為 `{"source":"provider-default","value":null}`，或 `{"source":"user","value":"實際選項 ID"}`。default 不送 setter；observed 未回報時保持 unknown。host key 是主端提供的持久識別／明示生成值，不是工具發現任意 CLI 視窗的機制。

input_file 是草稿 JSON，必填 schema_version、project_id、topic_id、run_id、exchange_id、previous_exchange_id（首封 null）、expected_topic_revision、attachments、authorization。attachments 每項帶 source_file、sha256、source_revision；工具封存為內容 hash 路徑。authorization 必須有 ref、scope=text-and-listed-snapshots、allowed_attachment_hashes。可選 request_sha256、outbound_sha256 供預先核對。

continuity 省略即 auto：同 run 接 previous_exchange_id 時嘗試已記錄的原生 session。缺能力或失效就回 session-reconstruction-required，不偷偷重試。主端可明確準備必要且已授權的舊信摘錄，在**新 exchange** 指定 letters-reconstructed；工具不自行追加整段歷史。同 topic 跨主 session 的接續也採新 run 加授權摘錄。

## 並行、等待與資料限制

run-open.timeout_ms 控制 prompt 期限（100 到 3600000ms）；取消寬限 10000ms，外層 hard timeout 為 prompt+15000ms。exchange 未指定 PowerShell -TimeoutMs 時使用 run 快照，並核對 run hash 未變；status 等本機操作仍使用 wrapper 預設期限。明確傳 -TimeoutMs 是該呼叫的外層覆寫，invocation 記錄來源及實際值；若刻意設得比 prompt 加寬限還短，可能導致 unknown，並不保證服務端取消。一般呼叫只需設定 run-open 的期限。

同 run 同時只允許一個送信；另一個新 exchange 得到 run-busy，草稿保留。不同 run 可同時完成且不依回信時間配對。主端可處理其他工作；回信保存不會背景打字或自動修改專案。只有主端 note 的 premise-change 會增加 topic revision，舊回信顯示 needs_reassessment。

工具使用 run 專屬的包內 `_private/work/<run-id>` 作 reviewer cwd，避免 Windows 深目錄啟動限制；它不是隔離沙箱。所有外送材料仍是封存 outbound 的內容。路徑檢查阻止已存在的 reparse、UNC、ADS、越界；不能抵擋其他惡意程序在核對後替換路徑。詳見 [資料界線](data-boundaries.md)。

程序收據、hash 及私人評估不提供簽章信任，也不能證明摘要語意完整。已公開或已被 Git 追蹤的私人資料不能靠新增 ignore 檔撤回；工具遇到追蹤狀態會停止寫入。Windows、Node、.NET Framework 與 reviewer 是執行前提；本頁不宣稱 Linux/VPS 或真實四 agent 矩陣已驗證。
