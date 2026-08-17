# Protocol.psm1
# 職責：合法狀態轉移、round/cap 算術、Reviewer 結果的結構化交叉驗證、next_action 推導。
# 不碰檔案 I/O（交給 StateStore.psm1）、不呼叫 Reviewer（交給 ReviewerAdapter.psm1）、
# 不做語意判斷（duplicate/reopen、Fix 是否合理——這些是 Producer 的工作）。
#
# 設計依據：diagnostic snapshot 第 13 節 Step 4 決定 1、跨 Step 決定 1「狀態與停點」。

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Script:HumanStates = @('preparing', 'confirmed-recoverable', 'reviewing', 'waiting-user', 'ended')
$Script:WaitReasons = @('material-decision', 'package-reconfirmation', 'final-confirmation', 'arbitration', 'manual-recovery')

# 合法主狀態轉移表（來源 -> 允許的目的地清單）。技術 checkpoint（prepared...state_committed）不算主狀態，不出現在這裡。
$Script:LegalTransitions = @{
    'preparing'              = @('preparing', 'confirmed-recoverable')
    'confirmed-recoverable'  = @('confirmed-recoverable', 'reviewing')
    'reviewing'              = @('reviewing', 'waiting-user', 'ended')
    'waiting-user'           = @('waiting-user', 'reviewing', 'confirmed-recoverable', 'ended')
    'ended'                  = @('ended')
}

function Test-HumanStateTransition {
    <# .SYNOPSIS 檢查 From -> To 是否為合法主狀態轉移；不合法時回傳 $false。 #>
    param([Parameter(Mandatory)][string]$From, [Parameter(Mandatory)][string]$To)
    if ($Script:HumanStates -notcontains $From) { throw "unknown-human-state: '$From'" }
    if ($Script:HumanStates -notcontains $To) { throw "unknown-human-state: '$To'" }
    $Script:LegalTransitions[$From] -contains $To
}

function Test-WaitReason {
    param([Parameter(Mandatory)][string]$HumanState, $WaitReason)
    if ($HumanState -eq 'waiting-user') {
        if ($null -eq $WaitReason) { throw 'wait-reason-required: human_state=waiting-user 必須帶 wait_reason' }
        if ($Script:WaitReasons -notcontains $WaitReason) { throw "unknown-wait-reason: '$WaitReason'" }
    } elseif ($null -ne $WaitReason) {
        throw "wait-reason-must-be-null: human_state='$HumanState' 不應帶 wait_reason"
    }
    $true
}

function Test-RoundAgainstCap {
    <#
    .SYNOPSIS 給定「本輪完成後的 round 數」與 cap，回傳 'continue'（可以送下一個 final round）或 'cap-reached'。
    .DESCRIPTION 呼叫端只在「本輪已經是可判定的 final outcome」時呼叫這個函式；
    MATERIAL_REQUIRED 造成的同輪 attempt 不算完成一個 round，不應該送進來檢查。
    #>
    param([Parameter(Mandatory)][int]$CompletedRound, [Parameter(Mandatory)][int]$Cap)
    if ($CompletedRound -gt $Cap) { throw "round-exceeds-cap: completed_round=$CompletedRound cap=$Cap（腳本邏輯錯誤，不應該發生）" }
    if ($CompletedRound -eq $Cap) { return 'cap-reached' }
    return 'continue'
}

function Test-MaterialRequestsAgainstCap {
    <#
    .SYNOPSIS 給定「目前已累計用掉的補件筆數」與「這次 MATERIAL_REQUIRED 要求的筆數」，回傳
    'continue'（可以放行、建立新的補件請求）或 'cap-reached'（改觸發使用者仲裁，不再建立補件請求）。
    .DESCRIPTION 上限管的是整個 review 累計的補件『筆數』（material_requests[] 裡的項目數加總），
    不是「被要求補件的輪次」——同一次 MATERIAL_REQUIRED 若一口氣要求多筆，這裡一次全部計入。
    比照 SKILL.md 舊機制「全程最多 3 次逐字引用」的安全上限（2026-08-17 補上，v1 移植時原本漏掉）。
    #>
    param(
        [Parameter(Mandatory)][int]$UsedSoFar,
        [Parameter(Mandatory)][int]$RequestedThisTime,
        [Parameter(Mandatory)][int]$MaterialCap
    )
    if (($UsedSoFar + $RequestedThisTime) -gt $MaterialCap) { return 'cap-reached' }
    return 'continue'
}

function New-IncreasedCap {
    <# .SYNOPSIS 使用者在 cap 後新增輪數：新絕對 cap = 目前已達輪數 + 使用者核准的額外輪數。不是把 cap 重設成一個會被目前輪數立即超過的小數字。 #>
    param([Parameter(Mandatory)][int]$CurrentRound, [Parameter(Mandatory)][int]$AdditionalRounds)
    if ($AdditionalRounds -lt 1) { throw 'additional-rounds-must-be-positive' }
    $CurrentRound + $AdditionalRounds
}

function Test-ReviewerResult {
    <#
    .SYNOPSIS 交叉驗證 Reviewer 結果（已通過 schema 驗證後）跟目前 open issue 集合是否一致。
    .DESCRIPTION 規則（diagnostic snapshot Step4 決定1 第5點）：
      - 每個 submitted open issue 恰有一個合法 disposition。
      - CONSENSUS 當且僅當沒有 open disposition（FIX_INSUFFICIENT/MAINTAIN）、沒有 new issue、沒有 pending material。
      - ISSUES_RAISED 必須至少有一項未決（新問題，或某個 disposition 是 FIX_INSUFFICIENT/MAINTAIN）。
      矛盾或缺項回傳 'reviewer_protocol_repair_required'（呼叫端據此走 advance 的固定一次修復再失敗轉 manual_recovery，
      不得猜測或用自由文字包含判定去讀 narrative）。
    .OUTPUTS 'valid' 或 'reviewer_protocol_repair_required'。
    #>
    param(
        [Parameter(Mandatory)][object]$Result,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$OpenIssueIds
    )
    if ($Result.outcome -eq 'MATERIAL_REQUIRED') {
        if (($Result.dispositions | Measure-Object).Count -gt 0) { return 'reviewer_protocol_repair_required' }
        if (($Result.new_issues | Measure-Object).Count -gt 0) { return 'reviewer_protocol_repair_required' }
        if (($Result.material_requests | Measure-Object).Count -lt 1) { return 'reviewer_protocol_repair_required' }
        return 'valid'
    }

    $dispositionIds = @($Result.dispositions | ForEach-Object { $_.issue_id })
    $openSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$OpenIssueIds)
    $dispSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$dispositionIds)
    if (-not $openSet.SetEquals($dispSet)) { return 'reviewer_protocol_repair_required' }

    $hasOpenDisposition = $false
    foreach ($d in $Result.dispositions) {
        if ($d.disposition -in @('FIX_INSUFFICIENT', 'MAINTAIN')) { $hasOpenDisposition = $true }
    }
    $hasNewIssue = (($Result.new_issues | Measure-Object).Count -gt 0)

    if ($Result.outcome -eq 'CONSENSUS') {
        if ($hasOpenDisposition -or $hasNewIssue) { return 'reviewer_protocol_repair_required' }
        return 'valid'
    }
    if ($Result.outcome -eq 'ISSUES_RAISED') {
        if (-not ($hasOpenDisposition -or $hasNewIssue)) { return 'reviewer_protocol_repair_required' }
        return 'valid'
    }
    return 'reviewer_protocol_repair_required'
}

function Update-IssueStatus {
    <# .SYNOPSIS 依 disposition 計算 issue 的新 status（純函式，不寫檔）。 #>
    param([Parameter(Mandatory)][string]$PreviousStatus, [Parameter(Mandatory)][string]$Disposition)
    switch ($Disposition) {
        'FIX_ACCEPTED'     { return 'fixed-accepted' }
        'CONCEDE'          { return 'conceded' }
        'FIX_INSUFFICIENT' { return 'open' }
        'MAINTAIN'         { return 'maintained-open' }
        default            { throw "unknown-disposition: '$Disposition'" }
    }
}

function Get-NextAction {
    <#
    .SYNOPSIS 依 human_state／wait_reason／current_operation 推導 next_action，供 status/advance 回傳給 Controller。
    .DESCRIPTION 只依 review-state.json 已有欄位＋（reviewing 狀態下）呼叫端提供的最近一輪 ledger outcome 做確定性推導；
    不猜測、不讀 narrative。
    .PARAMETER LastRoundOutcome
        只有 human_state=reviewing 時才有意義：呼叫端從 state.latest_ledger_ref 指向的 ledger 檔讀出的
        該輪 outcome（'CONSENSUS'／'ISSUES_RAISED'／$null）。Protocol.psm1 本身不做檔案 I/O，
        所以這個判斷所需的額外資訊由呼叫端讀完傳進來，不是這個函式自己去讀檔。
    .NOTES
        confirmed-recoverable 狀態下沒有專屬的 next_action 值可用——decision doc 定義的最小集合
        是給「advance 停下來、需要人／Producer 決定」的停點用的；round 1 是純機械步驟（從已確認
        package 直接組 prompt），advance 呼叫後會自動繼續，不會停在這裡等輸入。這裡回傳
        'provide_producer_response' 只是借用最相近的既有值，不是新語意；stdout 的呼叫端不應該
        誤以為這代表「要等 Producer 先給東西」——真正需要 Producer 輸入的是 reviewing 狀態下
        current_operation 為 null 且上一輪是 ISSUES_RAISED 的情況（下面另外處理）。
    #>
    param([Parameter(Mandatory)][object]$State, [string]$LastRoundOutcome = $null)

    if ($State.human_state -eq 'ended') { return 'done' }

    if ($State.human_state -eq 'preparing') { return 'confirm_updated_package' }

    if ($State.human_state -eq 'waiting-user') {
        switch ($State.wait_reason) {
            'material-decision'      { return 'provide_material_or_unavailable' }
            'package-reconfirmation' { return 'confirm_updated_package' }
            'final-confirmation'     { return 'confirm_final_package' }
            'arbitration'            { return 'choose_arbitration' }
            'manual-recovery'        { return 'resolve_manual_recovery' }
            default                  { return 'error' }
        }
    }

    if ($State.human_state -eq 'confirmed-recoverable') {
        return 'provide_producer_response'   # 見上方 .NOTES；實際行為是呼叫 advance 自動送出 round 1。
    }

    if ($State.human_state -eq 'reviewing') {
        if ($null -ne $State.current_operation -and $State.current_operation.checkpoint -eq 'manual_recovery_required') {
            return 'resolve_manual_recovery'
        }
        if ($null -eq $State.current_operation) {
            if ($LastRoundOutcome -eq 'CONSENSUS') { return 'prepare_final_package' }
            return 'provide_producer_response'
        }
        return 'normalize_reviewer_result'
    }

    return 'error'
}

function Test-HandoffShape {
    <# .SYNOPSIS 對應 schemas/handoff.schema.json 的手寫結構驗證。 #>
    param([Parameter(Mandatory)][object]$Handoff, [Parameter(Mandatory)][string]$ExpectedFinalPackageHash)
    try {
        if ($Handoff.schema_version -ne '1.0.0') { return $false }
        if ([string]::IsNullOrEmpty($Handoff.review_id)) { return $false }
        if ($Handoff.final_package_hash -ne $ExpectedFinalPackageHash) { return $false }
        if ([string]::IsNullOrEmpty($Handoff.conclusion_summary)) { return $false }
        # 2026-08-17 一致性檢查補上：schema 的 required 清單裡有 accepted_fixes／acceptance_criteria，
        # 先前這裡漏了存在性檢查（見 consistency-checklist.md 第一節第 1 項）。陣列可以是空的，
        # 但欄位本身要存在（PSCustomObject 缺欄位時存取回傳 $null，藉此判斷）。
        if ($null -eq $Handoff.accepted_fixes) { return $false }
        if ($null -eq $Handoff.acceptance_criteria) { return $false }
        if ($null -eq $Handoff.target_baseline) { return $false }
        $tb = $Handoff.target_baseline
        if ($tb.status -notin @('captured', 'unavailable', 'not-applicable')) { return $false }
        if ($tb.kind -notin @('files', 'artifact', 'external', 'none')) { return $false }
        if ($tb.status -eq 'captured' -and $tb.kind -eq 'files' -and (($tb.files | Measure-Object).Count -lt 1)) { return $false }
        if ($Handoff.follow_up_required -isnot [bool]) { return $false }
        if ($Handoff.follow_up_type -notin @('none', 'implementation', 'user-action')) { return $false }
        if ($Handoff.follow_up_required -eq $true -and $Handoff.follow_up_type -eq 'none') { return $false }
        if ($Handoff.follow_up_required -eq $false -and $Handoff.follow_up_type -ne 'none') { return $false }
        return $true
    } catch {
        return $false
    }
}

function Test-ProducerResponseShape {
    <#
    .SYNOPSIS 對應 schemas/producer-response.schema.json 的手寫結構驗證（含 2026-08-16 補上的
    reviewer_tag_plausible 對稱稽核義務：Fix／Pushback 都要填，標籤不合理時必須附理由）。
    .PARAMETER OpenIssueIds
        目前 submitted 的 open issue id 清單；每個 open issue 必須恰有一個 action，不多不少。
    .OUTPUTS $true／$false。
    #>
    param([Parameter(Mandatory)][object]$Response, [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$OpenIssueIds)
    try {
        if ($Response.schema_version -ne '1.0.0') { return $false }
        if ($null -eq $Response.round -or $Response.round -lt 1) { return $false }
        $actions = @($Response.actions)
        if ($actions.Count -lt 1) { return $false }

        $seenIds = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($a in $actions) {
            if ($a.issue_id -notmatch '^I[0-9]{4,}$') { return $false }
            if (-not $seenIds.Add($a.issue_id)) { return $false }   # 同一 issue 出現超過一次
            if ($a.action -notin @('fix', 'pushback')) { return $false }
            if ($null -eq $a.reviewer_tag_plausible -or $a.reviewer_tag_plausible -isnot [bool]) { return $false }
            if ($a.reviewer_tag_plausible -eq $false -and [string]::IsNullOrEmpty($a.reviewer_tag_dispute_reason)) { return $false }
            if ($a.action -eq 'fix' -and [string]::IsNullOrEmpty($a.fix_proposal)) { return $false }
            if ($a.action -eq 'pushback') {
                if ([string]::IsNullOrEmpty($a.pushback_reason)) { return $false }
                if ($a.verification -notin @('可查證且已查證', '可查證但未查證', '純屬判斷')) { return $false }
            }
        }

        $openSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$OpenIssueIds)
        if (-not $openSet.SetEquals($seenIds)) { return $false }   # 每個 open issue 恰有一個 action，不多不少
        return $true
    } catch {
        return $false
    }
}

function Test-MaterialResponseShape {
    <#
    .SYNOPSIS 對應 schemas/material-response.schema.json 的手寫結構驗證。
    .DESCRIPTION 2026-08-17 一致性檢查補上：review-collab.ps1 的 material-response 分支先前完全沒有
    呼叫任何驗證函式就直接寫入狀態（見 consistency-checklist.md 第一節第 2 項）——內容格式錯誤或缺欄位
    會延遲到很後面才顯現。這裡補上跟 Test-ProducerResponseShape／Test-HandoffShape 同樣模式的驗證。
    .OUTPUTS $true／$false。
    #>
    param([Parameter(Mandatory)][object]$Response)
    try {
        if ($Response.schema_version -ne '1.0.0') { return $false }
        if ([string]::IsNullOrEmpty($Response.request_id)) { return $false }
        if ($Response.status -notin @('provided', 'unavailable')) { return $false }
        if ($Response.status -eq 'provided') {
            if ($null -eq $Response.excerpt) { return $false }
            if ([string]::IsNullOrEmpty($Response.excerpt.content)) { return $false }
            if ($Response.excerpt.content.Length -gt 2000) { return $false }
            if ([string]::IsNullOrEmpty($Response.excerpt.source_locator)) { return $false }
        }
        return $true
    } catch {
        return $false
    }
}

Export-ModuleMember -Function `
    Test-HumanStateTransition, Test-WaitReason, Test-RoundAgainstCap, Test-MaterialRequestsAgainstCap, New-IncreasedCap, `
    Test-ReviewerResult, Update-IssueStatus, Get-NextAction, Test-ProducerResponseShape, Test-HandoffShape, `
    Test-MaterialResponseShape
