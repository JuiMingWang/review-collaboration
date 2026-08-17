# ReviewerAdapter.psm1
# 職責：Reviewer 呼叫的安全順序（prepared -> launch_intent_saved -> thread_captured ->
# result_validated -> state_committed）、operation receipt 保存、reviewer-result 的結構驗證。
# 不做語意判斷（Fix/Pushback、duplicate/reopen 交給 Producer；合法轉移/round-cap 交給 Protocol.psm1）。
#
# 設計依據：diagnostic snapshot 第 13 節 Step 3 決定 1。
#
# 呼叫哪個「Reviewer 命令」用 -ReviewerCommand 參數注入（見 Invoke-ReviewerCall），
# 正式使用時指向 codex exec；測試一律指向 tests/fixtures 底下的假 adapter 腳本，
# 不在自動化測試中呼叫真的 codex（會花真實 codex 額度／需要網路與登入）。
#
# 這個模組的呼叫是同步（前景）執行；是否要用背景執行＋輪詢確認終止，是呼叫這支腳本的
# Claude/Controller 自己的責任（例如用 run_in_background + TaskOutput），不是這支腳本要解決的問題——
# 這支腳本本身只是一個一般的命令列程序，背景化與否由呼叫端決定。

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ModuleRoot = Split-Path $PSScriptRoot -Parent | Split-Path -Parent
# -Global：PowerShell 預設把「模組內部再 Import-Module」的結果當成該模組自己的 nested module，
# 呼叫端（review-collab.ps1）看不到，也會讓呼叫端自己先 import 的同一份模組被換掉——實測發現這個
# bug：少了 -Global 時，Confirm-Package 等 StateStore 函式在頂層完全找不到。-Global 讓這裡的
# import 掛回全域 session state，等同呼叫端自己 import 的效果，兩邊看到同一份函式。
Import-Module (Join-Path $PSScriptRoot 'StateStore.psm1') -Force -Global
Import-Module (Join-Path $PSScriptRoot 'Protocol.psm1') -Force -Global

function New-OperationId {
    "op-$([Guid]::NewGuid().ToString('N').Substring(0,16))"
}

function Test-ReviewerResultShape {
    <#
    .SYNOPSIS 純結構驗證（對應 schemas/reviewer-result.schema.json），不做開放 issue 交叉檢查。
    .OUTPUTS $true／$false。呼叫端把 $false 視為 schema_valid=$false。
    #>
    param([Parameter(Mandatory)][object]$Result)
    try {
        if ($Result.schema_version -ne '1.0.0') { return $false }
        if ($Result.outcome -notin @('CONSENSUS', 'ISSUES_RAISED', 'MATERIAL_REQUIRED')) { return $false }
        if ($null -eq $Result.narrative) { return $false }

        $dispositions = @($Result.dispositions)
        $newIssues = @($Result.new_issues)
        $materialRequests = @($Result.material_requests)

        foreach ($d in $dispositions) {
            if ($d.issue_id -notmatch '^I[0-9]{4,}$') { return $false }
            if ($d.disposition -notin @('FIX_ACCEPTED', 'FIX_INSUFFICIENT', 'CONCEDE', 'MAINTAIN')) { return $false }
        }
        foreach ($n in $newIssues) {
            if ([string]::IsNullOrEmpty($n.summary)) { return $false }
            if ($n.type -notin @('錯誤型', '解法覆蓋型')) { return $false }
            if ($n.verification -notin @('可查證且已查證', '可查證但未查證', '純屬判斷')) { return $false }
        }
        foreach ($m in $materialRequests) {
            if ([string]::IsNullOrEmpty($m.claim_id)) { return $false }
            if ([string]::IsNullOrEmpty($m.codex_request_summary)) { return $false }
        }

        if ($Result.outcome -eq 'MATERIAL_REQUIRED') {
            if ($dispositions.Count -gt 0 -or $newIssues.Count -gt 0) { return $false }
            if ($materialRequests.Count -lt 1) { return $false }
        } else {
            if ($materialRequests.Count -gt 0) { return $false }
        }
        if ($Result.outcome -eq 'CONSENSUS') {
            foreach ($d in $dispositions) {
                if ($d.disposition -notin @('FIX_ACCEPTED', 'CONCEDE')) { return $false }
            }
            if ($newIssues.Count -gt 0) { return $false }
        }
        return $true
    } catch {
        return $false
    }
}

function Invoke-ReviewerCall {
    <#
    .SYNOPSIS 對單一 round 執行一次完整、安全的 Reviewer 呼叫，回傳最終 checkpoint 與（若成功）reviewer-result 物件。
    .PARAMETER ReviewerCommand
        Hashtable：@{ FilePath = <可執行檔>; ArgumentList = <string[]> }。
        呼叫時會把 -PromptFile / -OutFile / -EventsFile / -ThreadId(可為空) 用固定順序附加到 ArgumentList 後面——
        真實 codex adapter 與測試用假 adapter 都遵守這個固定呼叫介面，見 tests/fixtures/fake-codex.ps1。
    .PARAMETER OpenIssueIds
        目前 submitted 的 open issue id 清單，用來做 Protocol.Test-ReviewerResult 的交叉驗證。
    .OUTPUTS
        Hashtable：@{ Checkpoint=<string>; OperationId=<string>; Result=<object|$null>; ResultHash=<string|$null>; Error=<string|$null> }
    #>
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$ReviewId,
        [Parameter(Mandatory)][int]$ExpectedRevision,
        [Parameter(Mandatory)][int]$Round,
        [Parameter(Mandatory)][string]$PromptText,
        [Parameter(Mandatory)][hashtable]$ReviewerCommand,
        [string]$ThreadId,
        [AllowEmptyCollection()][string[]]$OpenIssueIds = @(),
        [int]$TimeoutSeconds = 120
    )

    $activeDir = Get-ActiveDir -ProjectRoot $ProjectRoot -ReviewId $ReviewId
    $roundsDir = Join-Path $activeDir 'rounds'
    New-Item -ItemType Directory -Path $roundsDir -Force | Out-Null
    $operationId = New-OperationId
    $attempt = 1
    $promptFile = Join-Path $roundsDir "prompt_r$Round.txt"
    $eventsFile = Join-Path $roundsDir "r$Round.events.jsonl"
    $resultFile = Join-Path $roundsDir "r$Round.json"

    # --- checkpoint: prepared -> launch_intent_saved --------------------------------------------
    Set-Utf8NoBom -Path $promptFile -Content $PromptText
    $lockHandle = Enter-ReviewLock -ProjectRoot $ProjectRoot -ReviewId $ReviewId -TimeoutMs 5000
    if ($null -eq $lockHandle) {
        return @{ Checkpoint = 'manual_recovery_required'; OperationId = $operationId; Result = $null; ResultHash = $null; Error = 'review-busy' }
    }
    try {
        $state = Get-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId
        if ($null -eq $state -or [int]$state.revision -ne $ExpectedRevision) {
            return @{ Checkpoint = 'manual_recovery_required'; OperationId = $operationId; Result = $null; ResultHash = $null; Error = 'revision-conflict-before-launch' }
        }
        $state.current_operation = [pscustomobject]@{
            operation_id = $operationId; kind = 'review-call'; round = $Round; attempt = $attempt
            checkpoint = 'launch_intent_saved'; prompt_ref = $promptFile; events_ref = $eventsFile; result_ref = $null; error = $null
        }
        Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $state -ExpectedRevision $ExpectedRevision | Out-Null
        $rev = $ExpectedRevision + 1
    } finally {
        Exit-ReviewLock -Lock $lockHandle
    }

    # --- 啟動 Reviewer（同步）--------------------------------------------------------------------
    # Start-Process 的 -ArgumentList 不接受空字串元素（實測會直接丟 ValidateNotNullOrEmpty 例外），
    # 所以 ThreadId 是空的時候乾脆不附加 -ThreadId 旗標，不能傳 -ThreadId ''。
    $args = @($ReviewerCommand.ArgumentList) + @('-PromptFile', $promptFile, '-OutFile', $resultFile, '-EventsFile', $eventsFile)
    if ($ThreadId) { $args += @('-ThreadId', $ThreadId) }
    $processFailed = $false
    $exitCode = $null
    try {
        $proc = Start-Process -FilePath $ReviewerCommand.FilePath -ArgumentList $args -NoNewWindow -PassThru -Wait `
                    -RedirectStandardOutput "$eventsFile.stdout" -RedirectStandardError "$eventsFile.stderr" `
                    -ErrorAction Stop
        $exitCode = $proc.ExitCode
    } catch {
        $processFailed = $true
    }

    # --- checkpoint: thread_captured（看到 thread.started 立即持久化，不等結果驗證完成）--------------
    $capturedThreadId = $ThreadId
    if (-not $processFailed -and (Test-Path $eventsFile)) {
        $line = Select-String -Path $eventsFile -Pattern '"thread\.started"' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($line) {
            try { $capturedThreadId = ($line.Line | ConvertFrom-Json).thread_id } catch { }
        }
    }
    if ($capturedThreadId -and $capturedThreadId -ne $ThreadId) {
        $lockHandle = Enter-ReviewLock -ProjectRoot $ProjectRoot -ReviewId $ReviewId -TimeoutMs 5000
        if ($null -ne $lockHandle) {
            try {
                $state = Get-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId
                if ($null -ne $state -and [int]$state.revision -eq $rev) {
                    $state.current_thread_id = $capturedThreadId
                    $state.current_operation.checkpoint = 'thread_captured'
                    Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $state -ExpectedRevision $rev | Out-Null
                    $rev = $rev + 1
                }
            } finally { Exit-ReviewLock -Lock $lockHandle }
        }
    }

    if ($processFailed -or $exitCode -ne 0 -or -not (Test-Path $resultFile)) {
        return @{ Checkpoint = 'manual_recovery_required'; OperationId = $operationId; Result = $null; ResultHash = $null; Error = "process-not-trusted: exitCode=$exitCode processFailed=$processFailed" }
    }

    # --- checkpoint: result_validated ------------------------------------------------------------
    $resultRaw = Read-Utf8 -Path $resultFile
    $resultHash = Get-StringSha256 -Text $resultRaw
    $completionSeen = (Select-String -Path $eventsFile -Pattern '"turn\.completed"|"response\.completed"|"thread\.completed"' -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
    $resultObj = $null
    $schemaValid = $false
    try {
        $resultObj = $resultRaw | ConvertFrom-Json
        $schemaValid = Test-ReviewerResultShape -Result $resultObj
    } catch { $schemaValid = $false }

    if (-not $completionSeen -or -not $schemaValid) {
        return @{ Checkpoint = 'reviewer_protocol_repair_required'; OperationId = $operationId; Result = $resultObj; ResultHash = $resultHash; Error = "completionSeen=$completionSeen schemaValid=$schemaValid" }
    }

    $crossCheck = Test-ReviewerResult -Result $resultObj -OpenIssueIds $OpenIssueIds
    if ($crossCheck -ne 'valid') {
        return @{ Checkpoint = 'reviewer_protocol_repair_required'; OperationId = $operationId; Result = $resultObj; ResultHash = $resultHash; Error = $crossCheck }
    }

    # --- 保存 operation receipt（immutable）--------------------------------------------------------
    $receiptsDir = Join-Path $activeDir 'operations'
    New-Item -ItemType Directory -Path $receiptsDir -Force | Out-Null
    $receipt = [pscustomobject]@{
        schema_version    = '1.0.0'
        operation_id      = $operationId
        round             = $Round
        attempt           = $attempt
        package_hash      = ''   # 由呼叫端（advance 流程）填入目前 package hash 後覆寫；此處先留供 Save 時補齊
        thread_id         = $capturedThreadId
        prompt_ref        = $promptFile
        result_ref        = $resultFile
        checkpoint_reached = 'result_validated'
        validated         = [pscustomobject]@{
            process_terminated   = -not $processFailed
            exit_code_zero       = ($exitCode -eq 0)
            not_killed           = -not $processFailed
            completion_event_seen = $completionSeen
            schema_valid         = $schemaValid
            result_hash          = $resultHash
        }
        error = $null
    }
    Set-JsonAtomic -Path (Join-Path $receiptsDir "$operationId.json") -Object $receipt

    return @{
        Checkpoint  = 'result_validated'
        OperationId = $operationId
        ThreadId    = $capturedThreadId
        Result      = $resultObj
        ResultHash  = $resultHash
        Revision    = $rev
        Error       = $null
    }
}

Export-ModuleMember -Function New-OperationId, Test-ReviewerResultShape, Invoke-ReviewerCall
