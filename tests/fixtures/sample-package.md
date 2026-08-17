你是獨立審查者，這是一個持續對話——Claude 將修復或反駁你提出的每個論點；你將在後續輪次重新評估直到達成共識。不要橡皮圖章，也不要無事生非故意拖長對話。

# REVIEW PACKAGE

## Problem
在專案中需要將舊版自由文字審查協作流程全面升級為 v1 結構化 JSON 協定與狀態機 CLI。

## Current Conclusion
採用方案 B：透過專屬 PowerShell CLI（review-collab.ps1）驅動狀態機與 Codex adapter，淘汰手工維護的 phase 轉換與自由文字解析。

## Constraints
- 嚴格維持 Windows PowerShell 5.1 相容性。
- 不直接修改正式 SKILL.md 檔案本體，只產出草稿供主線程審核。
- 嚴格遵守編碼規則（UTF-8 BOM-free，主控台編碼設定）。

## Key Assumptions And Verification
- 假設 1: v1 既有 82 個 Pester 測試已完整涵蓋狀態機邊界條件 [已查證: 執行 Invoke-Pester 全數通過]
- 假設 2: Codex CLI 支援 --output-schema 結構化輸出 [已查證: 既有測試與規格書確認]
- 假設 3: 角色框架前言置於 `# REVIEW PACKAGE` 前不會破壞 marker 驗證 [已查證: StateStore.Test-PackageMarkers 驗證通過]

## Alternatives Considered
- 方案 A: 僅局部替換 Step 3-4，其餘保留舊版散文與 review-log phase 機制。
- 方案 C: 重寫整個狀態機核心為二進位 CLI 工具。

## Unknowns
- 真實 Codex 模型在最新版本對中文繁體 prompt 結構化輸出的延遲波動。

## Excluded Content
- 無未揭露的敏感前提。

## Checklist
- 驗證 CodexAdapter 是否完整轉發所有必要旗標與 UTF-8 編碼。
- 驗證 package.md 的 10 個 marker 是否完整依序排列。
- 驗證委派執行子任務能否依照 next_action 正確分支處理。

## Ceiling Breaker
Beyond the checklist above, also actively consider whether there's a fundamentally different angle or solution this checklist and the discussion never touched at all —don't limit yourself to what's listed.

## Evidence Sources
- 任務規格書 docs/planB-task-spec.md
- 診斷設計文件 docs/skillmd-integration-design.md
