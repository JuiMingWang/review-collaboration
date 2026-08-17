# canonical package 格式（Markdown，非 JSON）

設計依據：diagnostic snapshot 第 13 節 Step 2 決定 1。

canonical package 是單一人類可讀 Markdown 檔案，**身分是完整 SHA-256**（不是檔名、不是另一個 revision counter）。腳本只驗證下列 marker 是否存在、順序是否正確、是否唯一、檔案是否為 UTF-8；**不評斷段落語意或 checklist 品質** —— 語意完整性仍由 Producer 整理與使用者確認負責。

## 必要 section marker（依序、不可重複）

```
# REVIEW PACKAGE
## Problem
## Current Conclusion
## Constraints
## Key Assumptions And Verification
## Alternatives Considered
## Unknowns
## Excluded Content
## Checklist
## Ceiling Breaker
## Evidence Sources
```

- `## Key Assumptions And Verification`：每項前提標註三態之一 —— `已查證`／`可查證但未查證`／`純屬判斷`；`已查證` 需附一句話說明查了什麼。
- `## Ceiling Breaker`：固定文字，逐字照抄（見 SKILL.md 現行 Step 2 的 verbatim 版本），不得每次改寫。
- `## Excluded Content`：若存在未揭露的敏感前提，本節只能寫「存在未提供的敏感前提及其造成的審查限制」，不得揭露內容本身。

## PowerShell 驗證範圍（`Test-PackageMarkers`）

1. 檔案是 UTF-8（BOM 皆可，但建議 BOM-free）。
2. 上述 10 個 marker 依序出現，且每個只出現一次。
3. 計算並回傳整檔完整 SHA-256（小寫 hex，64 字元）。
4. **不**做語意檢查（不檢查段落是否為空、不檢查查證標籤是否合理）——這些留給 Producer／使用者。

## 補件 artifact（不改動 base package）

`material-request-r<N>.json` 與其回應是**獨立、append-only** 的檔案，不回寫或改動已確認的 base package；即使補件內容改變了審查所需資訊，也是下一輪 Reviewer prompt 的一部分，不是 base package 的一部分。
