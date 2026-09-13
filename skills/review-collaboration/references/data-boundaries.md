# 資料界線

信件工具只投遞已封存的正文及授權清單中的內容快照。可以在本機查看舊信件，不代表可以整包送給 reviewer。新增摘錄須由主端判定是否在既有授權內；hash 核對只證明 bytes 相符，不證明人類真的同意或摘要語意完整。

主端可在委派前明列已核對的來源快照，以及允許 subagent 在後續信件引用的內容範圍。Subagent 在此範圍內查閱、選取相關摘錄，不必每次回主端轉問；每封新信仍按原有 Input／hash 契約封存。超出明列範圍或新增來源時，回主端判定既有授權是否涵蓋。這項預先判定不把整個可讀專案變成可外送材料。

ACP、空白工作目錄及關閉 client fs/terminal delegation，都不能阻止 reviewer 程序自行讀取全域規則、hooks、extensions 或檔案。啟動前必須先核對具體 adapter 的控制方式與認證來源。不能搬 auth、關閉安全功能或改用私人專案來湊測試通過。

material-control 是私人評估紀錄，格式為 schema_version=1、route_fingerprint、scope=text-and-listed-snapshots、startup_control、tool_control、sources（HTTPS 原始依據）及 synthetic_only。route 保存 evidence_ref 與 evidence_sha256；不存在、變動或不相符就停止。這只是可追溯評估及操作准入，不是 OS 隔離證明。合成 canary 未出現也不能證明完全沒有額外讀取。

正文／信件／來源位置／native session reference／操作證據留在專案 `.review-collaboration`；host 偏好、路線、身分證據及編譯快取留在 skill 的 `_private`。不得把兩者放進公開匯出。設定不保存帳號、token 或環境變數中的秘密。發行前仍須完成 T7 的逐檔匯出驗證。

第一版只使用本機普通 Windows 目錄。UNC、ADS、穿越、symlink／junction 拒絕。這些檢查不替代抵擋其他惡意程序同時置換路徑的 OS sandbox。已被 Git 追蹤的私人目錄停止寫入；不能改寫 Git 歷史或自動刪檔解決。

Windows 鎖小工具由包內 C# 源碼用內建 .NET Framework 編譯；唯一持久產物在 `_private/runtime/<source-hash>/`。source 與二進位 hash 核對後才執行。沒有常駐服務，沒有額外模型呼叫；快取不需搬移，換位置或來源變更可重建。Node、Windows .NET Framework 及 reviewer 自身是外部執行前提，不隨 skill 複製。
