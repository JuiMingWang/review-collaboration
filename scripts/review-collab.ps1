# review-collab.ps1
# 單一 PowerShell 入口：status / confirm-package / submit / advance / terminate。
# 每個 subcommand 都輸出一個固定形狀的 JSON 物件到 stdout（見 Write-Result 函式）。
#
# 設計依據：skillopt/review-collaboration-diagnostic-snapshot-2026-08-16.md 第 13 節
# 「跨 Step 決定 1」的「單一 PowerShell 入口」段落。
#
# 已知簡化（v1，未完整落實設計文件每一句話，見 docs/session-log.md 或本次 session 對使用者的回報）：
#   - new_issues 的 duplicate/reopen 語意判斷未實作；本版一律指派新的單調 issue_id，不做去重。
#   - Reviewer 呼叫固定同步（前景）執行，背景化／逾時輪詢由呼叫端（Claude Code 的 Bash 工具）負責。
#   - confirmed-recoverable 狀態沒有專屬 next_action 值，借用 provide_producer_response，見 Protocol.psm1 註解。
#   - final-approval 成功後同樣沒有獨立的「準備 handoff」next_action 值，借用 prepare_final_package
#     （與 CONSENSUS 後「準備 final package」共用同一個字串）；Controller 應依自己剛送出的 submit -Kind
#     判斷實際語意，不是靠這個字串本身區分兩種情境。
#   - cap 用盡、使用者選擇 increase-cap 繼續時（2026-08-17 決策，見 docs/session-log.md 同日條目），
#     v1 直接重用既有「ISSUES_RAISED -> 補交 producer-response -> 下一輪」路徑續行，不強制回頭走
#     confirm-package 或另外處理一份獨立的「新增輸入」artifact。診斷 snapshot 第 87、659 行描述的
#     「新增輸入仍走 Step 1/2」語意在 v1 沒有獨立實作；`package-reconfirmation` 這個 wait_reason 值
#     目前在 Protocol.psm1／schema 裡仍是合法列舉值，但沒有任何程式路徑會再產生它。

param(
    [Parameter(Mandatory)][ValidateSet('status', 'confirm-package', 'submit', 'advance', 'terminate')]
    [string]$Command,

    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$ReviewId,

    [string]$PackageFile,
    [int]$Cap = 5,
    [int]$MaterialCap = 3,

    [ValidateSet('producer-response', 'material-response', 'final-package', 'final-approval', 'handoff', 'arbitration')]
    [string]$Kind,
    [string]$InputFile,

    [string]$ReviewerExe,
    [string[]]$ReviewerArgs = @(),

    [ValidateSet('abandoned', 'superseded')]
    [string]$Reason
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'lib\StateStore.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib\Protocol.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib\ReviewerAdapter.psm1') -Force

function Write-Result {
    param(
        [bool]$Ok, [string]$HumanState = $null, [string]$WaitReason = $null,
        [string]$Checkpoint = $null, [string]$OperationId = $null, [string]$NextAction = $null,
        [object]$ArtifactRefs = $null, [string]$ErrorMessage = $null, [Nullable[int]]$Revision = $null
    )
    $obj = [pscustomobject]@{
        ok            = $Ok
        review_id     = $ReviewId
        revision      = $Revision
        human_state   = $HumanState
        wait_reason   = $WaitReason
        checkpoint    = $Checkpoint
        operation_id  = $OperationId
        next_action   = $NextAction
        artifact_refs = $ArtifactRefs
        error         = $ErrorMessage
    }
    Write-Output ($obj | ConvertTo-Json -Depth 10 -Compress)
}

function Get-LastLedgerOutcome {
    param([object]$State)
    if ($null -eq $State -or $null -eq $State.latest_ledger_ref) { return $null }
    $path = $State.latest_ledger_ref.path
    if (-not (Test-Path $path)) { return $null }
    (Read-Utf8 -Path $path | ConvertFrom-Json).outcome
}

function Get-OpenIssueIds {
    param([object]$State)
    if ($null -eq $State -or $null -eq $State.latest_ledger_ref) { return @() }
    $path = $State.latest_ledger_ref.path
    if (-not (Test-Path $path)) { return @() }
    $ledger = Read-Utf8 -Path $path | ConvertFrom-Json
    @($ledger.issues | Where-Object { $_.status -in @('open', 'maintained-open') } | ForEach-Object { $_.issue_id })
}

function Invoke-StatusCommand {
    $state = Get-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId
    if ($null -eq $state) {
        return Write-Result -Ok $true -HumanState $null -NextAction 'confirm_updated_package' -ErrorMessage $null
    }
    $lastOutcome = if ($state.human_state -eq 'reviewing') { Get-LastLedgerOutcome -State $state } else { $null }
    $next = Get-NextAction -State $state -LastRoundOutcome $lastOutcome
    $cp = if ($null -ne $state.current_operation) { $state.current_operation.checkpoint } else { $null }
    Write-Result -Ok $true -HumanState $state.human_state -WaitReason $state.wait_reason `
        -Checkpoint $cp -NextAction $next -Revision $state.revision
}

function Invoke-ConfirmPackageCommand {
    if (-not $PackageFile -or -not (Test-Path $PackageFile)) {
        return Write-Result -Ok $false -ErrorMessage "package-file-not-found: '$PackageFile'"
    }
    $content = Read-Utf8 -Path $PackageFile
    try {
        Confirm-Package -ProjectRoot $ProjectRoot -ReviewId $ReviewId -PackageContent $content -Cap $Cap -MaterialCap $MaterialCap | Out-Null
    } catch {
        return Write-Result -Ok $false -ErrorMessage $_.Exception.Message
    }
    $state = Get-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId
    Write-Result -Ok $true -HumanState $state.human_state -NextAction (Get-NextAction -State $state) -Revision $state.revision
}

function New-IssueIdSequence {
    <# .SYNOPSIS 從既有 ledger（若有）算出下一個可用的單調 I0001 類 ID 起點。純機械配號，不做語意去重（見檔頭已知簡化）。 #>
    param([object]$State)
    $maxNum = 0
    if ($null -ne $State -and $null -ne $State.latest_ledger_ref -and (Test-Path $State.latest_ledger_ref.path)) {
        $ledger = Read-Utf8 -Path $State.latest_ledger_ref.path | ConvertFrom-Json
        foreach ($iss in $ledger.issues) {
            if ($iss.issue_id -match '^I(\d+)$') { $n = [int]$Matches[1]; if ($n -gt $maxNum) { $maxNum = $n } }
        }
    }
    return $maxNum
}

function Invoke-AdvanceCommand {
    $state = Get-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId
    if ($null -eq $state) { return Write-Result -Ok $false -ErrorMessage 'not-initialized: call confirm-package first' }
    if ($state.human_state -in @('ended')) { return Write-Result -Ok $true -HumanState 'ended' -NextAction 'done' -Revision $state.revision }
    if ($state.human_state -eq 'waiting-user') {
        return Write-Result -Ok $true -HumanState $state.human_state -WaitReason $state.wait_reason `
            -NextAction (Get-NextAction -State $state) -Revision $state.revision -ErrorMessage 'blocked-on-user: call submit first'
    }
    if ($state.human_state -eq 'preparing') {
        return Write-Result -Ok $false -HumanState 'preparing' -NextAction 'confirm_updated_package' -ErrorMessage 'no-confirmed-package-yet'
    }

    # 到這裡：human_state 是 confirmed-recoverable 或 reviewing，且沒有卡在 waiting-user。
    $round = $state.completed_round + 1
    $reviewerCommand = if ($ReviewerExe) { @{ FilePath = $ReviewerExe; ArgumentList = $ReviewerArgs } } else {
        return Write-Result -Ok $false -ErrorMessage 'reviewer-command-not-configured: pass -ReviewerExe/-ReviewerArgs'
    }

    $openIssueIds = @(Get-OpenIssueIds -State $state)   # @() 防 PowerShell 把單一空陣列輸出摺疊成 $null 導致下面呼叫參數繫結失敗
    $packagePath = $state.current_package_ref.path
    $promptText = "ROUND $round PACKAGE HASH $($state.current_package_ref.package_hash)`n" + (Read-Utf8 -Path $packagePath)
    $producerResponseForThisRound = $null   # 若上一輪是 ISSUES_RAISED，下面會填入；稍後寫 ledger 時用來帶出 reviewer_tag_dispute_reason。

    if ($state.completed_round -gt 0) {
        # round > 1：上一輪若是 ISSUES_RAISED，這一輪的 prompt 必須帶上 Producer 剛 submit 的 Fix／Pushback
        # 內容，不能只重送 base package——否則 Codex 等於沒看到任何回應，協商迴圈不成立。
        $lastOutcome = Get-LastLedgerOutcome -State $state
        if ($lastOutcome -eq 'ISSUES_RAISED') {
            $respPath = Join-Path (Join-Path (Get-ActiveDir -ProjectRoot $ProjectRoot -ReviewId $ReviewId) 'rounds') "producer-response-r$($state.completed_round).json"
            if (-not (Test-Path $respPath)) {
                return Write-Result -Ok $false -HumanState $state.human_state -NextAction 'provide_producer_response' `
                    -Revision $state.revision -ErrorMessage "producer-response-required-first: expected '$respPath'"
            }
            $respObj = Read-Utf8 -Path $respPath | ConvertFrom-Json
            if (-not (Test-ProducerResponseShape -Response $respObj -OpenIssueIds $openIssueIds)) {
                return Write-Result -Ok $false -HumanState $state.human_state -NextAction 'provide_producer_response' `
                    -Revision $state.revision -ErrorMessage "producer-response-invalid-shape: '$respPath' 不符 schema 或跟目前 open issue 清單不一致（見 schemas/producer-response.schema.json，含 reviewer_tag_plausible 稽核欄位）"
            }
            $promptText += "`n`nPRODUCER RESPONSE (round $($state.completed_round)):`n" + (Read-Utf8 -Path $respPath)
            $producerResponseForThisRound = $respObj
        }
    }

    # 若這一輪（$round）先前拿到過 MATERIAL_REQUIRED，round 不會因此遞增，所以這裡跟被要求補件的
    # 是同一個輪數。這段跟上面 ISSUES_RAISED 的檢查各自獨立、可能同時成立（例如上一個完成的輪次是
    # ISSUES_RAISED，這一輪重打時又被要求補件），不能互斥處理——否則補件內容不會送給 Codex，
    # 等於補了等於沒補（2026-08-17 用真實 Codex 測 Test 3 時發現的落差）。
    $materialReqPath = Join-Path (Get-ActiveDir -ProjectRoot $ProjectRoot -ReviewId $ReviewId) "material-request-r$round.json"
    if (Test-Path $materialReqPath) {
        $materialReqObj = Read-Utf8 -Path $materialReqPath | ConvertFrom-Json
        $materialAnswers = New-Object System.Collections.Generic.List[string]
        foreach ($req in $materialReqObj.requests) {
            $ansPath = Join-Path (Join-Path (Get-ActiveDir -ProjectRoot $ProjectRoot -ReviewId $ReviewId) 'rounds') "material-response-$($req.claim_id).json"
            if (-not (Test-Path $ansPath)) {
                return Write-Result -Ok $false -HumanState $state.human_state -NextAction 'provide_material_or_unavailable' `
                    -Revision $state.revision -ErrorMessage "material-response-required-first: expected '$ansPath' for claim '$($req.claim_id)'"
            }
            $materialAnswers.Add((Read-Utf8 -Path $ansPath))
        }
        $promptText += "`n`nMATERIAL RESPONSE (round $round):`n" + ($materialAnswers -join "`n`n")
    }

    $callResult = Invoke-ReviewerCall -ProjectRoot $ProjectRoot -ReviewId $ReviewId -ExpectedRevision $state.revision `
        -Round $round -PromptText $promptText -ReviewerCommand $reviewerCommand `
        -ThreadId $state.current_thread_id -OpenIssueIds $openIssueIds

    if ($callResult.Checkpoint -eq 'reviewer_protocol_repair_required') {
        # 固定一次修復重試：把「請重送合法 JSON」的提示附加到同一輪 prompt，重打一次。
        $repairPrompt = $promptText + "`n`n[PROTOCOL REPAIR] 上一次回覆不符合 schema 或跟目前 open issue 清單不一致（$($callResult.Error)），請重新輸出合法結果。"
        $stateForRetry = Get-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId
        $callResult = Invoke-ReviewerCall -ProjectRoot $ProjectRoot -ReviewId $ReviewId -ExpectedRevision $stateForRetry.revision `
            -Round $round -PromptText $repairPrompt -ReviewerCommand $reviewerCommand `
            -ThreadId $stateForRetry.current_thread_id -OpenIssueIds $openIssueIds
    }

    if ($callResult.Checkpoint -in @('manual_recovery_required', 'reviewer_protocol_repair_required')) {
        # 兩個實測抓到的 bug（併發鎖測試逼出來的，不是憑程式碼閱讀猜的）：
        # 1) 鎖在 Invoke-ReviewerCall 最早期（連 current_operation 都還沒寫進 state）就逾時時，
        #    這裡原本無條件對 $s.current_operation.error 賦值，$null 物件會直接丟例外、
        #    不會走到 Write-Result，呼叫端收到的是未包裝的 PowerShell 錯誤，不是固定 JSON 形狀。
        # 2) 這裡自己也要重新取鎖來記錄 manual-recovery 標記；逾時回傳 $null 時原本沒檢查就
        #    繼續讀寫 state，等於繞過了鎖——跟 Invoke-SubmitCommand 既有的 review-busy 防護不一致。
        $lockHandle = Enter-ReviewLock -ProjectRoot $ProjectRoot -ReviewId $ReviewId -TimeoutMs 5000
        if ($null -eq $lockHandle) {
            return Write-Result -Ok $false -ErrorMessage 'review-busy: could not persist manual-recovery marker' `
                -Checkpoint $callResult.Checkpoint -OperationId $callResult.OperationId
        }
        try {
            $s = Get-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId
            $s.human_state = 'waiting-user'
            $s.wait_reason = 'manual-recovery'
            if ($null -ne $s.current_operation) {
                $s.current_operation.checkpoint = 'manual_recovery_required'
                $s.current_operation.error = $callResult.Error
            } else {
                $s.current_operation = [pscustomobject]@{
                    operation_id = $callResult.OperationId; kind = 'review-call'; round = $round; attempt = 1
                    checkpoint = 'manual_recovery_required'; prompt_ref = $null; events_ref = $null; result_ref = $null
                    error = $callResult.Error
                }
            }
            Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $s -ExpectedRevision $s.revision | Out-Null
        } finally { Exit-ReviewLock -Lock $lockHandle }
        return Write-Result -Ok $false -HumanState 'waiting-user' -WaitReason 'manual-recovery' `
            -Checkpoint $callResult.Checkpoint -OperationId $callResult.OperationId -NextAction 'resolve_manual_recovery' -ErrorMessage $callResult.Error
    }

    $result = $callResult.Result
    $lockHandle = Enter-ReviewLock -ProjectRoot $ProjectRoot -ReviewId $ReviewId -TimeoutMs 5000
    if ($null -eq $lockHandle) { return Write-Result -Ok $false -ErrorMessage 'review-busy' }
    try {
        $s = Get-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId
        $expectedRev = $s.revision

        if ($result.outcome -eq 'MATERIAL_REQUIRED') {
            # 補件次數上限（2026-08-17 補上，比照 SKILL.md 舊機制「全程最多 3 次逐字引用」的安全閥——
            # v1 移植時原本沒有對應上限，Codex 理論上可以無限次要求補件）。舊 state 檔可能沒有這兩個
            # 欄位（此功能加入前建立的 review），$null 時視同尚未使用過任何額度。
            $materialCap = if ($null -ne $s.material_cap) { [int]$s.material_cap } else { 3 }
            $usedSoFar = if ($null -ne $s.material_requests_used) { [int]$s.material_requests_used } else { 0 }
            $requestedThisTime = (@($result.material_requests)).Count
            if ((Test-MaterialRequestsAgainstCap -UsedSoFar $usedSoFar -RequestedThisTime $requestedThisTime -MaterialCap $materialCap) -eq 'cap-reached') {
                $s.human_state = 'waiting-user'
                $s.wait_reason = 'arbitration'
                if ($null -ne $s.current_operation) { $s.current_operation.checkpoint = 'state_committed'; $s.current_operation.result_ref = $callResult.OperationId }
                Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $s -ExpectedRevision $expectedRev | Out-Null
                return Write-Result -Ok $true -HumanState 'waiting-user' -WaitReason 'arbitration' `
                    -Checkpoint 'state_committed' -OperationId $callResult.OperationId -NextAction 'choose_arbitration' `
                    -Revision ($expectedRev + 1)
            }

            $activeDir = Get-ActiveDir -ProjectRoot $ProjectRoot -ReviewId $ReviewId
            $reqPath = Join-Path $activeDir "material-request-r$round.json"
            $reqObj = [pscustomobject]@{
                schema_version = '1.0.0'; round = $round; requests = $result.material_requests
            }
            Set-JsonAtomic -Path $reqPath -Object $reqObj
            $s.human_state = 'waiting-user'
            $s.wait_reason = 'material-decision'
            $s.pending_input_ref = $reqPath
            $s.material_requests_used = $usedSoFar + $requestedThisTime
            if ($null -ne $s.current_operation) { $s.current_operation.checkpoint = 'state_committed'; $s.current_operation.result_ref = $callResult.OperationId }
            Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $s -ExpectedRevision $expectedRev | Out-Null
            return Write-Result -Ok $true -HumanState 'waiting-user' -WaitReason 'material-decision' `
                -Checkpoint 'state_committed' -OperationId $callResult.OperationId -NextAction 'provide_material_or_unavailable' `
                -ArtifactRefs @{ material_request = $reqPath } -Revision ($expectedRev + 1)
        }

        # CONSENSUS 或 ISSUES_RAISED：完成本輪，寫 ledger snapshot。
        $activeDir = Get-ActiveDir -ProjectRoot $ProjectRoot -ReviewId $ReviewId
        $ledgerDir = Join-Path $activeDir 'ledger'
        New-Item -ItemType Directory -Path $ledgerDir -Force | Out-Null

        $prevIssues = @{}
        if ($null -ne $s.latest_ledger_ref -and (Test-Path $s.latest_ledger_ref.path)) {
            $prevLedger = Read-Utf8 -Path $s.latest_ledger_ref.path | ConvertFrom-Json
            foreach ($iss in $prevLedger.issues) { $prevIssues[$iss.issue_id] = $iss }
        }
        # disposition -> ledger event 名稱對照（不是單純 .ToLower()：CONCEDE/MAINTAIN 是現在式，
        # schema 的 history event enum 用的是過去式 conceded/maintained，兩者拼法不同，混用會讓寫出來的
        # ledger 過不了 schema 驗證）。
        $dispositionToEvent = @{
            'FIX_ACCEPTED'     = 'fix_accepted'
            'FIX_INSUFFICIENT' = 'fix_insufficient'
            'CONCEDE'          = 'conceded'
            'MAINTAIN'         = 'maintained'
        }
        $disputedIssueIds = @{}
        if ($null -ne $producerResponseForThisRound) {
            foreach ($a in $producerResponseForThisRound.actions) {
                if ($a.reviewer_tag_plausible -eq $false) { $disputedIssueIds[$a.issue_id] = $true }
            }
        }
        $producerResponsePath = if ($null -ne $producerResponseForThisRound) { $respPath } else { $null }
        foreach ($d in $result.dispositions) {
            if ($prevIssues.ContainsKey($d.issue_id)) {
                $iss = $prevIssues[$d.issue_id]
                $iss.status = Update-IssueStatus -PreviousStatus $iss.status -Disposition $d.disposition
                $historyList = New-Object System.Collections.Generic.List[object]
                if ($iss.history) { $iss.history | ForEach-Object { $historyList.Add($_) } }
                $historyList.Add([pscustomobject]@{ round = $round; event = $dispositionToEvent[$d.disposition]; ref = $callResult.OperationId })
                if ($disputedIssueIds.ContainsKey($d.issue_id)) {
                    # 2026-08-16 對稱稽核決定（見 diagnostic snapshot Step 4 決定 2）：Producer 對這個 issue
                    # 原本查證標籤有爭議，記進 ledger history（ref 指回 producer-response 檔，理由文字留在
                    # 該檔裡，不重複存兩份），不因為最終選了 Fix 就消失不見。
                    $historyList.Add([pscustomobject]@{ round = $round; event = 'reviewer_tag_disputed'; ref = $producerResponsePath })
                }
                $iss.history = $historyList.ToArray()
            }
        }
        $nextIdNum = New-IssueIdSequence -State $s
        foreach ($n in $result.new_issues) {
            $nextIdNum++
            $newId = 'I{0:D4}' -f $nextIdNum
            $prevIssues[$newId] = [pscustomobject]@{
                issue_id = $newId; origin_ref = $callResult.OperationId; origin_hash = $callResult.ResultHash
                summary = $n.summary; status = 'open'
                history = @([pscustomobject]@{ round = $round; event = 'raised'; ref = $callResult.OperationId })
            }
        }

        $ledgerObj = [pscustomobject]@{
            schema_version = '1.0.0'; round = $round; package_hash = $s.current_package_ref.package_hash
            operation_refs = @($callResult.OperationId); outcome = $result.outcome
            issues = @($prevIssues.Values); created_at = (Get-Date).ToUniversalTime().ToString('o')
        }
        $ledgerJson = $ledgerObj | ConvertTo-Json -Depth 20
        $ledgerHash = Get-StringSha256 -Text $ledgerJson
        $ledgerPath = Join-Path $ledgerDir "r$round.ledger.json"
        Set-Utf8NoBom -Path $ledgerPath -Content $ledgerJson

        $s.completed_round = $round
        $s.current_thread_id = $callResult.ThreadId
        $s.latest_ledger_ref = [pscustomobject]@{ round = $round; ledger_hash = $ledgerHash; path = $ledgerPath }
        $s.current_operation = $null

        if ($result.outcome -eq 'CONSENSUS') {
            $s.human_state = 'reviewing'   # 只等 Producer 準備 final package，仍屬 reviewing（見 Protocol.psm1 註解）。
            $s.wait_reason = $null
            Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $s -ExpectedRevision $expectedRev | Out-Null
            return Write-Result -Ok $true -HumanState 'reviewing' -Checkpoint 'state_committed' -OperationId $callResult.OperationId `
                -NextAction 'prepare_final_package' -ArtifactRefs @{ ledger = $ledgerPath } -Revision ($expectedRev + 1)
        }

        # ISSUES_RAISED
        $capDecision = Test-RoundAgainstCap -CompletedRound $round -Cap $s.cap
        if ($capDecision -eq 'cap-reached') {
            $s.human_state = 'waiting-user'
            $s.wait_reason = 'arbitration'
            Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $s -ExpectedRevision $expectedRev | Out-Null
            return Write-Result -Ok $true -HumanState 'waiting-user' -WaitReason 'arbitration' -Checkpoint 'state_committed' `
                -OperationId $callResult.OperationId -NextAction 'choose_arbitration' -ArtifactRefs @{ ledger = $ledgerPath } -Revision ($expectedRev + 1)
        }
        $s.human_state = 'reviewing'
        $s.wait_reason = $null
        Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $s -ExpectedRevision $expectedRev | Out-Null
        return Write-Result -Ok $true -HumanState 'reviewing' -Checkpoint 'state_committed' -OperationId $callResult.OperationId `
            -NextAction 'provide_producer_response' -ArtifactRefs @{ ledger = $ledgerPath } -Revision ($expectedRev + 1)
    } finally {
        Exit-ReviewLock -Lock $lockHandle
    }
}

function Invoke-SubmitCommand {
    if (-not $Kind) { return Write-Result -Ok $false -ErrorMessage 'missing-kind' }
    if (-not $InputFile -or -not (Test-Path $InputFile)) { return Write-Result -Ok $false -ErrorMessage "input-file-not-found: '$InputFile'" }
    $state = Get-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId
    if ($null -eq $state) { return Write-Result -Ok $false -ErrorMessage 'not-initialized' }

    # final-package 的 InputFile 是 Markdown（canonical package 格式），不是 JSON——其餘 Kind 都是 JSON。
    $inputObj = if ($Kind -ne 'final-package') { Read-Utf8 -Path $InputFile | ConvertFrom-Json } else { $null }
    $lockHandle = Enter-ReviewLock -ProjectRoot $ProjectRoot -ReviewId $ReviewId -TimeoutMs 5000
    if ($null -eq $lockHandle) { return Write-Result -Ok $false -ErrorMessage 'review-busy' }
    try {
        $s = Get-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId
        $expectedRev = $s.revision
        $activeDir = Get-ActiveDir -ProjectRoot $ProjectRoot -ReviewId $ReviewId

        switch ($Kind) {
            'producer-response' {
                if ($s.human_state -ne 'reviewing') { return Write-Result -Ok $false -ErrorMessage "wrong-state-for-producer-response: $($s.human_state)" }
                $openIds = @(Get-OpenIssueIds -State $s)
                if (-not (Test-ProducerResponseShape -Response $inputObj -OpenIssueIds $openIds)) {
                    return Write-Result -Ok $false -HumanState $s.human_state -Revision $expectedRev `
                        -ErrorMessage 'producer-response-invalid-shape: 見 schemas/producer-response.schema.json（含 reviewer_tag_plausible 稽核欄位）與目前 open issue 清單'
                }
                $dir = Join-Path $activeDir 'rounds'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $path = Join-Path $dir "producer-response-r$($inputObj.round).json"
                Set-Utf8NoBom -Path $path -Content (Read-Utf8 -Path $InputFile)
                return Write-Result -Ok $true -HumanState $s.human_state -NextAction 'provide_producer_response' `
                    -ArtifactRefs @{ producer_response = $path } -Revision $expectedRev
            }
            'material-response' {
                if ($s.human_state -ne 'waiting-user' -or $s.wait_reason -ne 'material-decision') {
                    return Write-Result -Ok $false -ErrorMessage 'wrong-state-for-material-response'
                }
                if (-not (Test-MaterialResponseShape -Response $inputObj)) {
                    return Write-Result -Ok $false -HumanState $s.human_state -Revision $expectedRev `
                        -ErrorMessage 'material-response-invalid-shape: 見 schemas/material-response.schema.json'
                }
                $dir = Join-Path $activeDir 'rounds'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $path = Join-Path $dir "material-response-$($inputObj.request_id).json"
                Set-Utf8NoBom -Path $path -Content (Read-Utf8 -Path $InputFile)
                $s.human_state = 'reviewing'
                $s.wait_reason = $null
                $s.pending_input_ref = $null
                Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $s -ExpectedRevision $expectedRev | Out-Null
                return Write-Result -Ok $true -HumanState 'reviewing' -NextAction 'provide_producer_response' `
                    -ArtifactRefs @{ material_response = $path } -Revision ($expectedRev + 1)
            }
            'final-package' {
                if ($s.human_state -ne 'reviewing') { return Write-Result -Ok $false -ErrorMessage "wrong-state-for-final-package: $($s.human_state)" }
                $content = Read-Utf8 -Path $InputFile
                $hash = Get-StringSha256 -Text $content
                $dir = Join-Path $activeDir 'final'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $path = Join-Path $dir "$hash.final-package.md"
                Set-Utf8NoBom -Path $path -Content $content
                $s.finalization = [pscustomobject]@{
                    candidate_ref = [pscustomobject]@{ hash = $hash; path = $path }; approval_ref = $null; handoff_ref = $null
                }
                $s.human_state = 'waiting-user'
                $s.wait_reason = 'final-confirmation'
                Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $s -ExpectedRevision $expectedRev | Out-Null
                return Write-Result -Ok $true -HumanState 'waiting-user' -WaitReason 'final-confirmation' -NextAction 'confirm_final_package' `
                    -ArtifactRefs @{ final_package = $path; final_package_hash = $hash } -Revision ($expectedRev + 1)
            }
            'final-approval' {
                if ($s.human_state -ne 'waiting-user' -or $s.wait_reason -ne 'final-confirmation') {
                    return Write-Result -Ok $false -ErrorMessage 'wrong-state-for-final-approval'
                }
                if ($inputObj.approved_hash -ne $s.finalization.candidate_ref.hash) {
                    return Write-Result -Ok $false -ErrorMessage "hash-mismatch: approved '$($inputObj.approved_hash)' but candidate is '$($s.finalization.candidate_ref.hash)'"
                }
                $approvalObj = [pscustomobject]@{ schema_version = '1.0.0'; approved_hash = $inputObj.approved_hash; approved_at = (Get-Date).ToUniversalTime().ToString('o') }
                $approvalPath = Join-Path (Join-Path $activeDir 'final') 'approval.json'
                Set-JsonAtomic -Path $approvalPath -Object $approvalObj
                $s.finalization.approval_ref = [pscustomobject]@{ hash = (Get-StringSha256 -Text ($approvalObj | ConvertTo-Json)); path = $approvalPath }
                $s.human_state = 'reviewing'   # 核准後只等 Producer 準備 handoff，仍屬 reviewing（跟 CONSENSUS 後等 final package 同一類）。
                $s.wait_reason = $null
                Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $s -ExpectedRevision $expectedRev | Out-Null
                # next_action 借用既有值 prepare_final_package：diagnostic-snapshot 732 行定義的最小集合裡
                # 沒有獨立的「準備 handoff」語意，這裡跟 confirmed-recoverable 借用 provide_producer_response
                # 是同一種模式（見檔頭「已知簡化」）。不放進 ErrorMessage——ok=true 時 error 應維持空，
                # 否則呼叫端若用 error 是否為空判斷成敗會誤判。
                return Write-Result -Ok $true -HumanState 'reviewing' `
                    -NextAction 'prepare_final_package' -ArtifactRefs @{ approval = $approvalPath } -Revision ($expectedRev + 1)
            }
            'handoff' {
                if ($s.human_state -ne 'reviewing' -or $null -eq $s.finalization -or $null -eq $s.finalization.approval_ref) {
                    return Write-Result -Ok $false -ErrorMessage 'wrong-state-for-handoff: final package 尚未核准'
                }
                $expectedHash = $s.finalization.candidate_ref.hash
                if (-not (Test-HandoffShape -Handoff $inputObj -ExpectedFinalPackageHash $expectedHash)) {
                    return Write-Result -Ok $false -ErrorMessage 'handoff-invalid-shape: 見 schemas/handoff.schema.json，或 final_package_hash 跟已核准的 candidate 不符'
                }
                $handoffContent = Read-Utf8 -Path $InputFile
                $handoffPath = Join-Path (Join-Path $activeDir 'final') 'handoff.json'
                Set-Utf8NoBom -Path $handoffPath -Content $handoffContent
                $handoffHash = Get-StringSha256 -Text $handoffContent
                $s.finalization.handoff_ref = $handoffPath

                # --- Step 5a 收尾：保存 history bundle → 驗證 hash → 最後寫入 completion.json ------------------
                $historyDir = Get-HistoryDir -ProjectRoot $ProjectRoot -ReviewId $ReviewId
                New-Item -ItemType Directory -Path $historyDir -Force | Out-Null
                $requiredArtifacts = New-Object System.Collections.Generic.List[object]

                function Copy-IntoHistory {
                    param([string]$SourcePath, [string]$RelativeName)
                    $destPath = Join-Path $historyDir $RelativeName
                    $destParent = Split-Path -Parent $destPath
                    if (-not (Test-Path $destParent)) { New-Item -ItemType Directory -Path $destParent -Force | Out-Null }
                    Copy-Item -Path $SourcePath -Destination $destPath -Force
                    $hash = Get-FileSha256 -Path $destPath
                    $requiredArtifacts.Add([pscustomobject]@{ relative_path = $RelativeName; sha256 = $hash })
                }
                Copy-IntoHistory -SourcePath $s.current_package_ref.path -RelativeName 'package.md'
                Copy-IntoHistory -SourcePath $s.finalization.candidate_ref.path -RelativeName 'final-package.md'
                Copy-IntoHistory -SourcePath $handoffPath -RelativeName 'handoff.json'
                $approvalFilePath = Join-Path (Join-Path $activeDir 'final') 'approval.json'
                if (Test-Path $approvalFilePath) { Copy-IntoHistory -SourcePath $approvalFilePath -RelativeName 'approval.json' }
                $ledgerDir = Join-Path $activeDir 'ledger'
                if (Test-Path $ledgerDir) {
                    Get-ChildItem -Path $ledgerDir -Filter '*.ledger.json' | ForEach-Object {
                        Copy-IntoHistory -SourcePath $_.FullName -RelativeName "ledger/$($_.Name)"
                    }
                }

                $completion = [pscustomobject]@{
                    schema_version    = '1.0.0'
                    review_id         = $ReviewId
                    ended_reason      = 'consensus-finalized'
                    final_package_ref = [pscustomobject]@{ path = (Join-Path $historyDir 'final-package.md'); sha256 = $s.finalization.candidate_ref.hash }
                    handoff_ref       = [pscustomobject]@{ path = (Join-Path $historyDir 'handoff.json'); sha256 = $handoffHash }
                    # @($genericList) 在 PS 5.1 對 List[object] 轉陣列偶爾會丟
                    # "Argument types do not match"（PSEnumerableBinder 已知相容性問題），改用 .ToArray() 明確轉型。
                    required_artifacts = $requiredArtifacts.ToArray()
                    completed_at      = (Get-Date).ToUniversalTime().ToString('o')
                }
                Set-JsonAtomic -Path (Join-Path $historyDir 'completion.json') -Object $completion

                $s.human_state = 'ended'
                $s.wait_reason = $null
                Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $s -ExpectedRevision $expectedRev | Out-Null
                return Write-Result -Ok $true -HumanState 'ended' -NextAction 'done' -Revision ($expectedRev + 1) `
                    -ArtifactRefs @{ completion = (Join-Path $historyDir 'completion.json') }
            }
            'arbitration' {
                if ($s.human_state -ne 'waiting-user' -or $s.wait_reason -ne 'arbitration') {
                    return Write-Result -Ok $false -ErrorMessage 'wrong-state-for-arbitration'
                }
                if ($inputObj.choice -eq 'abandon') {
                    return Write-Result -Ok $true -HumanState $s.human_state -WaitReason $s.wait_reason -NextAction 'choose_arbitration' `
                        -Revision $expectedRev -ErrorMessage 'call terminate -Reason abandoned to close'
                } elseif ($inputObj.choice -eq 'increase-cap') {
                    # 2026-08-17 決策（方案 1，見 docs/session-log.md）：不強制回頭走 confirm-package
                    # 重新確認整份 package（那條路徑會導致 advance 永遠要求一份不可能存在的
                    # producer-response-r<cap-round>.json，是一個死路——cap-reached 那一輪的 ISSUES_RAISED
                    # ledger 早就寫好了，直接重用既有「ISSUES_RAISED -> provide_producer_response -> 下一輪」
                    # 續行路徑最小改動、且已被完整測試覆蓋；cap 本身只是防止無限輪次的煞車，跟「是否強制
                    # 使用者重新看過整份 package」是兩件獨立的事。
                    $newCap = New-IncreasedCap -CurrentRound $s.completed_round -AdditionalRounds $inputObj.additional_rounds
                    $s.cap = $newCap
                    $s.human_state = 'reviewing'
                    $s.wait_reason = $null
                    Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $s -ExpectedRevision $expectedRev | Out-Null
                    return Write-Result -Ok $true -HumanState 'reviewing' -NextAction 'provide_producer_response' `
                        -Revision ($expectedRev + 1)
                }
                return Write-Result -Ok $false -ErrorMessage "unknown-arbitration-choice: $($inputObj.choice)"
            }
        }
    } finally {
        Exit-ReviewLock -Lock $lockHandle
    }
}

function Invoke-TerminateCommand {
    if (-not $Reason) { return Write-Result -Ok $false -ErrorMessage 'missing-reason' }
    $state = Get-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId
    if ($null -eq $state) { return Write-Result -Ok $false -ErrorMessage 'not-initialized' }
    $lockHandle = Enter-ReviewLock -ProjectRoot $ProjectRoot -ReviewId $ReviewId -TimeoutMs 5000
    if ($null -eq $lockHandle) { return Write-Result -Ok $false -ErrorMessage 'review-busy' }
    try {
        $s = Get-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId
        $expectedRev = $s.revision
        $historyDir = Get-HistoryDir -ProjectRoot $ProjectRoot -ReviewId $ReviewId
        New-Item -ItemType Directory -Path $historyDir -Force | Out-Null
        $completion = [pscustomobject]@{
            schema_version = '1.0.0'; review_id = $ReviewId; ended_reason = $Reason
            final_package_ref = $null; handoff_ref = $null; required_artifacts = @()
            completed_at = (Get-Date).ToUniversalTime().ToString('o')
        }
        Set-JsonAtomic -Path (Join-Path $historyDir 'completion.json') -Object $completion
        $s.human_state = 'ended'
        $s.wait_reason = $null
        Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $s -ExpectedRevision $expectedRev | Out-Null
        return Write-Result -Ok $true -HumanState 'ended' -NextAction 'done' -Revision ($expectedRev + 1) `
            -ArtifactRefs @{ completion = (Join-Path $historyDir 'completion.json') }
    } finally {
        Exit-ReviewLock -Lock $lockHandle
    }
}

switch ($Command) {
    'status'          { Invoke-StatusCommand }
    'confirm-package' { Invoke-ConfirmPackageCommand }
    'submit'          { Invoke-SubmitCommand }
    'advance'         { Invoke-AdvanceCommand }
    'terminate'       { Invoke-TerminateCommand }
}
