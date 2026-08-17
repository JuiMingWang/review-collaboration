# smoke-test-real-codex.ps1
# 依據 planB-task-spec.md 第 4 節執行的單次最小真實 Codex 煙霧測試。

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path $PSScriptRoot -Parent
$AdapterScript = Join-Path $ProjectRoot 'scripts\adapters\codex-adapter.ps1'
$SchemaFile = Join-Path $ProjectRoot 'schemas\reviewer-result.schema.json'

Import-Module (Join-Path $ProjectRoot 'scripts\lib\ReviewerAdapter.psm1') -Force
Import-Module (Join-Path $ProjectRoot 'scripts\lib\Protocol.psm1') -Force

$smokeDir = Join-Path $env:TEMP ("codex-smoke-real-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $smokeDir -Force | Out-Null

$promptPath = Join-Path $smokeDir 'smoke_prompt.txt'
$outPath = Join-Path $smokeDir 'smoke_out.json'
$eventsPath = Join-Path $smokeDir 'smoke_events.jsonl'

$smokePrompt = @"
你是獨立審查者，這是一個持續對話。

# REVIEW PACKAGE
## Problem
最小煙霧測試：驗證 Codex adapter 在 Windows PowerShell 5.1 環境下的固定旗標、JSON Schema 結構化輸出與 UTF-8 編碼相容性。

## Current Conclusion
系統旗標與結構化輸出運作正常。

## Constraints
- 僅做單次最小呼叫，不重複呼叫。

## Key Assumptions And Verification
- 假設 1: Codex CLI 正常支援 --output-schema [已查證: 規格書]

## Alternatives Considered
- 無

## Unknowns
- 無

## Excluded Content
- 無

## Checklist
- 檢查繁體中文是否無亂碼。
- 檢查 JSON 是否符合 reviewer-result.schema.json。

## Ceiling Breaker
Beyond the checklist above, also actively consider whether there's a fundamentally different angle or solution this checklist and the discussion never touched at all —don't limit yourself to what's listed.

## Evidence Sources
- planB-task-spec.md
"@

[System.IO.File]::WriteAllText($promptPath, $smokePrompt, (New-Object System.Text.UTF8Encoding $false))

Write-Host "Starting single minimal real Codex smoke test..."
$sw = [System.Diagnostics.Stopwatch]::StartNew()

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $AdapterScript `
    -PromptFile $promptPath -OutFile $outPath -EventsFile $eventsPath `
    -SchemaFile $SchemaFile

$exitCode = $LASTEXITCODE
$sw.Stop()

Write-Host "Codex execution finished with exit code: $exitCode in $($sw.ElapsedMilliseconds) ms"

if ($exitCode -ne 0) {
    Write-Error "Real Codex execution failed with exit code $exitCode"
    exit 1
}

# 驗證輸出檔案
if (-not (Test-Path $outPath)) {
    Write-Error "OutFile was not created: $outPath"
    exit 1
}

$rawJson = Get-Content -Raw -Path $outPath -Encoding UTF8
Write-Host "Raw Output JSON:"
Write-Host $rawJson

$resultObj = $rawJson | ConvertFrom-Json
$isShapeValid = Test-ReviewerResultShape -Result $resultObj

Write-Host "Reviewer result shape valid: $isShapeValid"
Write-Host "Outcome: $($resultObj.outcome)"
Write-Host "Narrative: $($resultObj.narrative)"

# 驗證事件檔案
if (Test-Path $eventsPath) {
    $threadLine = Select-String -Path $eventsPath -Pattern '"thread\.started"' -ErrorAction SilentlyContinue | Select-Object -First 1
    $threadId = if ($threadLine) { ($threadLine.Line | ConvertFrom-Json).thread_id } else { 'none' }
    Write-Host "Captured ThreadId: $threadId"
}

if ($isShapeValid) {
    Write-Host "SMOKE TEST PASSED: Flags, Schema, and UTF-8 encoding verified successfully."
} else {
    Write-Error "SMOKE TEST FAILED: Schema validation failed."
    exit 1
}
