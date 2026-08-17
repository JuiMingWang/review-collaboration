# fake-codex.ps1
# 測試用假 Reviewer adapter，取代真實 `codex exec`。固定 CLI 介面跟 ReviewerAdapter.psm1
# 的 Invoke-ReviewerCall 呼叫慣例一致：-PromptFile -OutFile -EventsFile -ThreadId。
#
# 行為由 $env:FAKE_CODEX_SCENARIO 指向的 JSON 控制檔決定（見 tests/fixtures/scenarios/*.json）；
# 沒設定時預設回一個乾淨的 CONSENSUS。這支腳本本身不呼叫任何外部服務、不花費真實 codex 額度。

param(
    [string]$PromptFile,
    [string]$OutFile,
    [string]$EventsFile,
    [string]$ThreadId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scenarioPath = $env:FAKE_CODEX_SCENARIO
if ($scenarioPath -and (Test-Path $scenarioPath)) {
    # -Encoding UTF8 必須明講：Windows PowerShell 5.1 對沒有 BOM 的檔案預設用系統代碼頁讀取，
    # 中文會靜默讀成亂碼（不會丟例外），這裡的 scenario 檔含中文 summary，踩過一次這個坑。
    $scenario = Get-Content -Raw -Path $scenarioPath -Encoding UTF8 | ConvertFrom-Json
} else {
    $scenario = [pscustomobject]@{
        exitCode = 0
        threadId = 'fake-thread-default'
        emitThreadStarted = $true
        emitCompletion = $true
        resultRaw = $null   # 若設定，直接原樣寫入 OutFile（用來模擬 malformed JSON）
        result = [pscustomobject]@{
            schema_version = '1.0.0'; outcome = 'CONSENSUS'; narrative = 'looks fine'
            dispositions = @(); new_issues = @(); advisories = @(); material_requests = @()
        }
    }
}

$effectiveThreadId = if ($ThreadId) { $ThreadId } else { $scenario.threadId }

$events = New-Object System.Collections.Generic.List[string]
if ($scenario.emitThreadStarted) {
    $events.Add((@{ type = 'thread.started'; thread_id = $effectiveThreadId } | ConvertTo-Json -Compress))
}
if ($scenario.emitCompletion) {
    $events.Add((@{ type = 'turn.completed' } | ConvertTo-Json -Compress))
}
if ($EventsFile) {
    [System.IO.File]::WriteAllText($EventsFile, ($events -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
}

if ($OutFile) {
    if ($null -ne $scenario.resultRaw) {
        [System.IO.File]::WriteAllText($OutFile, [string]$scenario.resultRaw, (New-Object System.Text.UTF8Encoding $false))
    } else {
        $json = $scenario.result | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding $false))
    }
}

exit [int]$scenario.exitCode
