# Protocol.Tests.ps1
# 純邏輯單元測試：Protocol.psm1 不碰檔案 I/O、不呼叫 Reviewer，所以這裡全部測試都不需要
# fake-codex、不需要暫存目錄，跑起來最快，也不花任何 Codex 額度。

$modulePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\lib\Protocol.psm1'
Import-Module $modulePath -Force

Describe "Test-HumanStateTransition" {
    It "allows preparing -> confirmed-recoverable" {
        Test-HumanStateTransition -From 'preparing' -To 'confirmed-recoverable' | Should Be $true
    }
    It "rejects preparing -> ended (skips everything)" {
        Test-HumanStateTransition -From 'preparing' -To 'ended' | Should Be $false
    }
    It "allows reviewing -> waiting-user" {
        Test-HumanStateTransition -From 'reviewing' -To 'waiting-user' | Should Be $true
    }
    It "rejects ended -> anything else (terminal state)" {
        Test-HumanStateTransition -From 'ended' -To 'reviewing' | Should Be $false
    }
    It "throws on unknown source state" {
        { Test-HumanStateTransition -From 'bogus' -To 'ended' } | Should Throw 'unknown-human-state'
    }
}

Describe "Test-WaitReason" {
    It "requires a wait_reason when human_state is waiting-user" {
        { Test-WaitReason -HumanState 'waiting-user' -WaitReason $null } | Should Throw 'wait-reason-required'
    }
    It "accepts a known wait_reason" {
        Test-WaitReason -HumanState 'waiting-user' -WaitReason 'arbitration' | Should Be $true
    }
    It "rejects wait_reason on a non-waiting-user state" {
        { Test-WaitReason -HumanState 'reviewing' -WaitReason 'arbitration' } | Should Throw 'wait-reason-must-be-null'
    }
}

Describe "Test-RoundAgainstCap" {
    It "returns continue when below cap" {
        Test-RoundAgainstCap -CompletedRound 1 -Cap 3 | Should Be 'continue'
    }
    It "returns cap-reached when exactly at cap" {
        Test-RoundAgainstCap -CompletedRound 3 -Cap 3 | Should Be 'cap-reached'
    }
    It "throws if completed round somehow exceeds cap (script bug guard)" {
        { Test-RoundAgainstCap -CompletedRound 4 -Cap 3 } | Should Throw 'round-exceeds-cap'
    }
}

Describe "New-IncreasedCap" {
    It "adds additional rounds on top of the current round, not a fresh small number" {
        New-IncreasedCap -CurrentRound 3 -AdditionalRounds 2 | Should Be 5
    }
    It "rejects non-positive additional rounds" {
        { New-IncreasedCap -CurrentRound 3 -AdditionalRounds 0 } | Should Throw 'additional-rounds-must-be-positive'
    }
}

Describe "Test-ReviewerResult" {
    It "accepts a clean CONSENSUS with matching empty open set" {
        $r = [pscustomobject]@{ outcome = 'CONSENSUS'; dispositions = @(); new_issues = @(); material_requests = @() }
        Test-ReviewerResult -Result $r -OpenIssueIds @() | Should Be 'valid'
    }
    It "rejects CONSENSUS that still has a FIX_INSUFFICIENT disposition open" {
        $r = [pscustomobject]@{
            outcome = 'CONSENSUS'
            dispositions = @([pscustomobject]@{ issue_id = 'I0001'; disposition = 'FIX_INSUFFICIENT' })
            new_issues = @(); material_requests = @()
        }
        Test-ReviewerResult -Result $r -OpenIssueIds @('I0001') | Should Be 'reviewer_protocol_repair_required'
    }
    It "rejects CONSENSUS when dispositions don't cover every open issue id" {
        $r = [pscustomobject]@{
            outcome = 'CONSENSUS'
            dispositions = @([pscustomobject]@{ issue_id = 'I0001'; disposition = 'FIX_ACCEPTED' })
            new_issues = @(); material_requests = @()
        }
        Test-ReviewerResult -Result $r -OpenIssueIds @('I0001', 'I0002') | Should Be 'reviewer_protocol_repair_required'
    }
    It "accepts ISSUES_RAISED backed by a MAINTAIN disposition" {
        $r = [pscustomobject]@{
            outcome = 'ISSUES_RAISED'
            dispositions = @([pscustomobject]@{ issue_id = 'I0001'; disposition = 'MAINTAIN' })
            new_issues = @(); material_requests = @()
        }
        Test-ReviewerResult -Result $r -OpenIssueIds @('I0001') | Should Be 'valid'
    }
    It "rejects ISSUES_RAISED with nothing actually left open (contradicts its own outcome)" {
        $r = [pscustomobject]@{
            outcome = 'ISSUES_RAISED'
            dispositions = @([pscustomobject]@{ issue_id = 'I0001'; disposition = 'FIX_ACCEPTED' })
            new_issues = @(); material_requests = @()
        }
        Test-ReviewerResult -Result $r -OpenIssueIds @('I0001') | Should Be 'reviewer_protocol_repair_required'
    }
    It "accepts a clean MATERIAL_REQUIRED with no dispositions/new_issues and at least one request" {
        $r = [pscustomobject]@{
            outcome = 'MATERIAL_REQUIRED'; dispositions = @(); new_issues = @()
            material_requests = @([pscustomobject]@{ locator = 'foo' })
        }
        Test-ReviewerResult -Result $r -OpenIssueIds @('I0001') | Should Be 'valid'
    }
    It "rejects MATERIAL_REQUIRED that also tries to carry dispositions" {
        $r = [pscustomobject]@{
            outcome = 'MATERIAL_REQUIRED'
            dispositions = @([pscustomobject]@{ issue_id = 'I0001'; disposition = 'FIX_ACCEPTED' })
            new_issues = @(); material_requests = @([pscustomobject]@{ locator = 'foo' })
        }
        Test-ReviewerResult -Result $r -OpenIssueIds @('I0001') | Should Be 'reviewer_protocol_repair_required'
    }
}

Describe "Update-IssueStatus" {
    It "maps FIX_ACCEPTED to fixed-accepted" {
        Update-IssueStatus -PreviousStatus 'open' -Disposition 'FIX_ACCEPTED' | Should Be 'fixed-accepted'
    }
    It "maps CONCEDE to conceded" {
        Update-IssueStatus -PreviousStatus 'open' -Disposition 'CONCEDE' | Should Be 'conceded'
    }
    It "maps MAINTAIN to maintained-open (still counts as open for next round)" {
        Update-IssueStatus -PreviousStatus 'open' -Disposition 'MAINTAIN' | Should Be 'maintained-open'
    }
    It "throws on an unknown disposition value" {
        { Update-IssueStatus -PreviousStatus 'open' -Disposition 'BOGUS' } | Should Throw 'unknown-disposition'
    }
}

Describe "Get-NextAction" {
    It "returns done when ended" {
        Get-NextAction -State ([pscustomobject]@{ human_state = 'ended' }) | Should Be 'done'
    }
    It "returns confirm_updated_package when preparing" {
        Get-NextAction -State ([pscustomobject]@{ human_state = 'preparing' }) | Should Be 'confirm_updated_package'
    }
    It "maps waiting-user/arbitration to choose_arbitration" {
        $s = [pscustomobject]@{ human_state = 'waiting-user'; wait_reason = 'arbitration' }
        Get-NextAction -State $s | Should Be 'choose_arbitration'
    }
    It "returns prepare_final_package when reviewing with no pending op and last round was CONSENSUS" {
        $s = [pscustomobject]@{ human_state = 'reviewing'; current_operation = $null }
        Get-NextAction -State $s -LastRoundOutcome 'CONSENSUS' | Should Be 'prepare_final_package'
    }
    It "returns provide_producer_response when reviewing with no pending op and last round was ISSUES_RAISED" {
        $s = [pscustomobject]@{ human_state = 'reviewing'; current_operation = $null }
        Get-NextAction -State $s -LastRoundOutcome 'ISSUES_RAISED' | Should Be 'provide_producer_response'
    }
    It "returns resolve_manual_recovery when current_operation is flagged manual_recovery_required" {
        $s = [pscustomobject]@{ human_state = 'reviewing'; current_operation = [pscustomobject]@{ checkpoint = 'manual_recovery_required' } }
        Get-NextAction -State $s | Should Be 'resolve_manual_recovery'
    }
}

Describe "Test-HandoffShape" {
    function New-ValidHandoff {
        [pscustomobject]@{
            schema_version = '1.0.0'; review_id = 'r1'; final_package_hash = 'abc123'
            conclusion_summary = 'done'
            accepted_fixes = @(); acceptance_criteria = @()
            target_baseline = [pscustomobject]@{ status = 'not-applicable'; kind = 'none' }
            follow_up_required = $false; follow_up_type = 'none'
        }
    }
    It "accepts a minimal valid handoff" {
        Test-HandoffShape -Handoff (New-ValidHandoff) -ExpectedFinalPackageHash 'abc123' | Should Be $true
    }
    It "rejects a hash mismatch against the approved candidate" {
        Test-HandoffShape -Handoff (New-ValidHandoff) -ExpectedFinalPackageHash 'different' | Should Be $false
    }
    It "rejects follow_up_required=true paired with follow_up_type=none (contradiction)" {
        $h = New-ValidHandoff
        $h.follow_up_required = $true
        Test-HandoffShape -Handoff $h -ExpectedFinalPackageHash 'abc123' | Should Be $false
    }
    It "rejects status=captured/kind=files with an empty files list" {
        $h = New-ValidHandoff
        $h.target_baseline = [pscustomobject]@{ status = 'captured'; kind = 'files'; files = @() }
        Test-HandoffShape -Handoff $h -ExpectedFinalPackageHash 'abc123' | Should Be $false
    }
    # 2026-08-17 一致性檢查補上（consistency-checklist.md 第一節第 1 項）：schema 的 required 清單裡有
    # accepted_fixes／acceptance_criteria，先前這裡完全沒檢查，這兩個測試鎖住修好後的行為。
    It "rejects a handoff missing accepted_fixes (schema requires the field to exist)" {
        $h = New-ValidHandoff
        $h.PSObject.Properties.Remove('accepted_fixes')
        Test-HandoffShape -Handoff $h -ExpectedFinalPackageHash 'abc123' | Should Be $false
    }
    It "rejects a handoff missing acceptance_criteria (schema requires the field to exist)" {
        $h = New-ValidHandoff
        $h.PSObject.Properties.Remove('acceptance_criteria')
        Test-HandoffShape -Handoff $h -ExpectedFinalPackageHash 'abc123' | Should Be $false
    }
}

Describe "Test-MaterialResponseShape" {
    # 2026-08-17 一致性檢查新增（consistency-checklist.md 第一節第 2 項）：review-collab.ps1 的
    # material-response 分支先前完全沒有驗證，這裡補上跟 producer-response／handoff 同樣模式的測試。
    It "accepts status=unavailable without an excerpt" {
        $r = [pscustomobject]@{ schema_version = '1.0.0'; request_id = 'req1'; status = 'unavailable' }
        Test-MaterialResponseShape -Response $r | Should Be $true
    }
    It "accepts status=provided with a valid excerpt" {
        $r = [pscustomobject]@{
            schema_version = '1.0.0'; request_id = 'req1'; status = 'provided'
            excerpt = [pscustomobject]@{ content = 'some content'; source_locator = 'file.md#L1' }
        }
        Test-MaterialResponseShape -Response $r | Should Be $true
    }
    It "rejects status=provided with no excerpt" {
        $r = [pscustomobject]@{ schema_version = '1.0.0'; request_id = 'req1'; status = 'provided' }
        Test-MaterialResponseShape -Response $r | Should Be $false
    }
    It "rejects an excerpt longer than 2000 characters" {
        $r = [pscustomobject]@{
            schema_version = '1.0.0'; request_id = 'req1'; status = 'provided'
            excerpt = [pscustomobject]@{ content = ('x' * 2001); source_locator = 'file.md#L1' }
        }
        Test-MaterialResponseShape -Response $r | Should Be $false
    }
    It "rejects an unknown status value" {
        $r = [pscustomobject]@{ schema_version = '1.0.0'; request_id = 'req1'; status = 'bogus' }
        Test-MaterialResponseShape -Response $r | Should Be $false
    }
}

Describe "Test-ProducerResponseShape (含 2026-08-16 對稱稽核欄位)" {
    function New-ValidResponse {
        [pscustomobject]@{
            schema_version = '1.0.0'; round = 1
            actions = @(
                [pscustomobject]@{ issue_id = 'I0001'; action = 'fix'; fix_proposal = 'do X'; reviewer_tag_plausible = $true }
                [pscustomobject]@{ issue_id = 'I0002'; action = 'pushback'; pushback_reason = 'because Y'; verification = '可查證且已查證'; reviewer_tag_plausible = $true }
            )
        }
    }
    It "accepts a valid response covering exactly the open issue set" {
        Test-ProducerResponseShape -Response (New-ValidResponse) -OpenIssueIds @('I0001', 'I0002') | Should Be $true
    }
    It "rejects when an open issue has no matching action" {
        Test-ProducerResponseShape -Response (New-ValidResponse) -OpenIssueIds @('I0001', 'I0002', 'I0003') | Should Be $false
    }
    It "rejects when reviewer_tag_plausible=false has no dispute reason" {
        $r = New-ValidResponse
        $r.actions[0].reviewer_tag_plausible = $false
        Test-ProducerResponseShape -Response $r -OpenIssueIds @('I0001', 'I0002') | Should Be $false
    }
    It "accepts reviewer_tag_plausible=false when a dispute reason is given" {
        $r = New-ValidResponse
        $r.actions[0].reviewer_tag_plausible = $false
        $r.actions[0] | Add-Member -NotePropertyName reviewer_tag_dispute_reason -NotePropertyValue 'ADR 已存在，可查證' -Force
        Test-ProducerResponseShape -Response $r -OpenIssueIds @('I0001', 'I0002') | Should Be $true
    }
    It "rejects a pushback with no verification tag" {
        $r = New-ValidResponse
        $r.actions[1].PSObject.Properties.Remove('verification')
        Test-ProducerResponseShape -Response $r -OpenIssueIds @('I0001', 'I0002') | Should Be $false
    }
    It "rejects a duplicate issue_id across two actions" {
        $r = New-ValidResponse
        $r.actions += [pscustomobject]@{ issue_id = 'I0001'; action = 'fix'; fix_proposal = 'again'; reviewer_tag_plausible = $true }
        Test-ProducerResponseShape -Response $r -OpenIssueIds @('I0001', 'I0002') | Should Be $false
    }
}
