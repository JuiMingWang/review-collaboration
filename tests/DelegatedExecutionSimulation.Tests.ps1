# DelegatedExecutionSimulation.Tests.ps1
# 驗證 Task 2.3 與 2.4：以 fake-codex 模擬 Delegated execution 迴圈、狀態機轉換、Cap/Material 上限仲裁與 Finalize/Handoff 收尾。

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TestRoot = $PSScriptRoot
$ProjectRoot = Split-Path $TestRoot -Parent
$CollabScript = Join-Path $ProjectRoot 'scripts\review-collab.ps1'
$FakeCodexScript = Join-Path $ProjectRoot 'tests\fixtures\fake-codex.ps1'
$ScenariosDir = Join-Path $ProjectRoot 'tests\fixtures\scenarios'
$SamplePackage = Join-Path $ProjectRoot 'tests\fixtures\sample-package.md'

Import-Module (Join-Path $ProjectRoot 'scripts\lib\StateStore.psm1') -Force

Describe 'Delegated Execution and Finalization Simulation' {
    $tempDir = $null
    $reviewerCmdArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $FakeCodexScript)

    BeforeEach {
        $tempDir = Join-Path $env:TEMP ("review-sim-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    }

    AfterEach {
        if ($tempDir -and (Test-Path $tempDir)) {
            Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        Remove-Item env:FAKE_CODEX_SCENARIO -ErrorAction SilentlyContinue
    }

    It 'Scenario 1: Happy Path from confirm-package through multi-round to consensus and finalization' {
        $reviewId = 'rev-sim-happy'

        # 1. confirm-package
        $confirmOut = & $CollabScript `
            -Command 'confirm-package' -ProjectRoot $tempDir -ReviewId $reviewId `
            -PackageFile $SamplePackage -Cap 5 -MaterialCap 3 | ConvertFrom-Json

        $confirmOut.ok | Should Be $true
        $confirmOut.human_state | Should Be 'confirmed-recoverable'
        $confirmOut.next_action | Should Be 'provide_producer_response'

        # 2. Round 1: ISSUES_RAISED
        $env:FAKE_CODEX_SCENARIO = Join-Path $ScenariosDir 'issues-raised.json'
        $adv1 = & $CollabScript `
            -Command 'advance' -ProjectRoot $tempDir -ReviewId $reviewId `
            -ReviewerExe 'powershell.exe' -ReviewerArgs $reviewerCmdArgs | ConvertFrom-Json

        $adv1.ok | Should Be $true
        $adv1.human_state | Should Be 'reviewing'
        $adv1.next_action | Should Be 'provide_producer_response'
        $adv1.artifact_refs.ledger | Should Not BeNullOrEmpty

        # 3. Producer Response for Round 1
        $prodRespPath = Join-Path $tempDir 'producer-response-r1.json'
        $prodRespObj = @{
            schema_version = '1.0.0'
            round = 1
            actions = @(
                @{
                    issue_id = 'I0001'
                    action = 'fix'
                    reviewer_tag_plausible = $true
                    fix_proposal = 'Fix description for I0001.'
                    fix_rationale = 'Accept reviewer feedback'
                },
                @{
                    issue_id = 'I0002'
                    action = 'pushback'
                    reviewer_tag_plausible = $false
                    reviewer_tag_dispute_reason = 'Dispute reason for I0002 tag.'
                    pushback_reason = 'Pushback reason for I0002.'
                    verification = '可查證且已查證'
                }
            )
        } | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($prodRespPath, $prodRespObj, (New-Object System.Text.UTF8Encoding $false))

        $subProd = & $CollabScript `
            -Command 'submit' -ProjectRoot $tempDir -ReviewId $reviewId `
            -Kind 'producer-response' -InputFile $prodRespPath | ConvertFrom-Json

        $subProd.ok | Should Be $true
        $subProd.human_state | Should Be 'reviewing'

        # 4. Round 2: CONSENSUS resolving I0001 and I0002
        $round2ScenarioPath = Join-Path $tempDir 'r2-consensus-scenario.json'
        $round2ScenarioObj = @{
            exitCode = 0
            threadId = 'fake-thread-issues'
            emitThreadStarted = $true
            emitCompletion = $true
            resultRaw = $null
            result = @{
                schema_version = '1.0.0'
                outcome = 'CONSENSUS'
                narrative = 'both issues resolved'
                dispositions = @(
                    @{ issue_id = 'I0001'; disposition = 'FIX_ACCEPTED'; reason = 'fix looks good' },
                    @{ issue_id = 'I0002'; disposition = 'CONCEDE'; reason = 'conceded on explanation' }
                )
                new_issues = @()
                advisories = @()
                material_requests = @()
            }
        } | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($round2ScenarioPath, $round2ScenarioObj, (New-Object System.Text.UTF8Encoding $false))

        $env:FAKE_CODEX_SCENARIO = $round2ScenarioPath
        $adv2 = & $CollabScript `
            -Command 'advance' -ProjectRoot $tempDir -ReviewId $reviewId `
            -ReviewerExe 'powershell.exe' -ReviewerArgs $reviewerCmdArgs | ConvertFrom-Json

        $adv2.ok | Should Be $true
        $adv2.human_state | Should Be 'reviewing'
        $adv2.next_action | Should Be 'prepare_final_package'

        # 5. Step 5a: Final Package Submission
        $finalPkgPath = Join-Path $tempDir 'final-package.md'
        $finalPkgContent = (Get-Content -Raw $SamplePackage) + "`n`n## Final Changes Summary`n- Fix I0001`n- Pushback I0002"
        [System.IO.File]::WriteAllText($finalPkgPath, $finalPkgContent, (New-Object System.Text.UTF8Encoding $false))

        $subFinal = & $CollabScript `
            -Command 'submit' -ProjectRoot $tempDir -ReviewId $reviewId `
            -Kind 'final-package' -InputFile $finalPkgPath | ConvertFrom-Json

        $subFinal.ok | Should Be $true
        $subFinal.human_state | Should Be 'waiting-user'
        $subFinal.wait_reason | Should Be 'final-confirmation'
        $subFinal.next_action | Should Be 'confirm_final_package'
        $finalPkgHash = $subFinal.artifact_refs.final_package_hash

        # 6. User Approval
        $approvalPath = Join-Path $tempDir 'approval-input.json'
        $approvalObj = @{
            schema_version = '1.0.0'
            approved_hash = $finalPkgHash
        } | ConvertTo-Json
        [System.IO.File]::WriteAllText($approvalPath, $approvalObj, (New-Object System.Text.UTF8Encoding $false))

        $subAppr = & $CollabScript `
            -Command 'submit' -ProjectRoot $tempDir -ReviewId $reviewId `
            -Kind 'final-approval' -InputFile $approvalPath | ConvertFrom-Json

        $subAppr.ok | Should Be $true
        $subAppr.human_state | Should Be 'reviewing'
        $subAppr.next_action | Should Be 'prepare_final_package'

        # 7. Handoff Submission
        $handoffPath = Join-Path $tempDir 'handoff-input.json'
        $handoffObj = @{
            schema_version = '1.0.0'
            review_id = $reviewId
            final_package_hash = $finalPkgHash
            conclusion_summary = 'Review completed with consensus.'
            accepted_fixes = @('Fix description for I0001')
            constraints_and_tripwires = @('UTF8 BOM free')
            evidence_refs = @('docs/planB-task-spec.md')
            target_baseline = @{
                status = 'not-applicable'
                kind = 'none'
            }
            acceptance_criteria = @('All tests pass')
            follow_up_required = $false
            follow_up_type = 'none'
        } | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($handoffPath, $handoffObj, (New-Object System.Text.UTF8Encoding $false))

        $subHandoff = & $CollabScript `
            -Command 'submit' -ProjectRoot $tempDir -ReviewId $reviewId `
            -Kind 'handoff' -InputFile $handoffPath | ConvertFrom-Json

        $subHandoff.ok | Should Be $true
        $subHandoff.human_state | Should Be 'ended'
        $subHandoff.next_action | Should Be 'done'

        # Verify history bundle and completion.json
        $historyDir = Get-HistoryDir -ProjectRoot $tempDir -ReviewId $reviewId
        Test-Path (Join-Path $historyDir 'completion.json') | Should Be $true
        Test-Path (Join-Path $historyDir 'package.md') | Should Be $true
        Test-Path (Join-Path $historyDir 'final-package.md') | Should Be $true
        Test-Path (Join-Path $historyDir 'handoff.json') | Should Be $true
        Test-Path (Join-Path $historyDir 'approval.json') | Should Be $true
        Test-Path (Join-Path (Join-Path $historyDir 'ledger') 'r1.ledger.json') | Should Be $true
        Test-Path (Join-Path (Join-Path $historyDir 'ledger') 'r2.ledger.json') | Should Be $true
    }

    It 'Scenario 2: Cap exhausted leads to choose_arbitration and supports increase-cap' {
        $reviewId = 'rev-sim-cap'

        # Set Cap = 2
        & $CollabScript `
            -Command 'confirm-package' -ProjectRoot $tempDir -ReviewId $reviewId `
            -PackageFile $SamplePackage -Cap 2 -MaterialCap 3 | Out-Null

        # Round 1: ISSUES_RAISED
        $env:FAKE_CODEX_SCENARIO = Join-Path $ScenariosDir 'issues-raised.json'
        & $CollabScript `
            -Command 'advance' -ProjectRoot $tempDir -ReviewId $reviewId `
            -ReviewerExe 'powershell.exe' -ReviewerArgs $reviewerCmdArgs | Out-Null

        # Submit response with pushback
        $prodRespPath = Join-Path $tempDir 'producer-response-r1.json'
        $prodRespObj = @{
            schema_version = '1.0.0'; round = 1
            actions = @(
                @{ issue_id = 'I0001'; action = 'pushback'; reviewer_tag_plausible = $true; pushback_reason = 'Maintain stance'; verification = '純屬判斷' },
                @{ issue_id = 'I0002'; action = 'pushback'; reviewer_tag_plausible = $true; pushback_reason = 'Maintain stance'; verification = '純屬判斷' }
            )
        } | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($prodRespPath, $prodRespObj, (New-Object System.Text.UTF8Encoding $false))
        & $CollabScript `
            -Command 'submit' -ProjectRoot $tempDir -ReviewId $reviewId `
            -Kind 'producer-response' -InputFile $prodRespPath | Out-Null

        # Round 2: ISSUES_RAISED (MAINTAIN) - Cap reached
        $env:FAKE_CODEX_SCENARIO = Join-Path $ScenariosDir 'issues-raised-maintained.json'
        $adv2 = & $CollabScript `
            -Command 'advance' -ProjectRoot $tempDir -ReviewId $reviewId `
            -ReviewerExe 'powershell.exe' -ReviewerArgs $reviewerCmdArgs | ConvertFrom-Json

        $adv2.ok | Should Be $true
        $adv2.human_state | Should Be 'waiting-user'
        $adv2.wait_reason | Should Be 'arbitration'
        $adv2.next_action | Should Be 'choose_arbitration'

        # User chooses to increase-cap by 2
        $arbInputPath = Join-Path $tempDir 'arb-input.json'
        $arbObj = @{
            schema_version = '1.0.0'
            choice = 'increase-cap'
            additional_rounds = 2
        } | ConvertTo-Json
        [System.IO.File]::WriteAllText($arbInputPath, $arbObj, (New-Object System.Text.UTF8Encoding $false))

        $subArb = & $CollabScript `
            -Command 'submit' -ProjectRoot $tempDir -ReviewId $reviewId `
            -Kind 'arbitration' -InputFile $arbInputPath | ConvertFrom-Json

        $subArb.ok | Should Be $true
        $subArb.human_state | Should Be 'reviewing'
        $subArb.next_action | Should Be 'provide_producer_response'
    }

    It 'Scenario 3: Material cap exhausted leads to choose_arbitration' {
        $reviewId = 'rev-sim-matcap'

        # Set MaterialCap = 1
        & $CollabScript `
            -Command 'confirm-package' -ProjectRoot $tempDir -ReviewId $reviewId `
            -PackageFile $SamplePackage -Cap 5 -MaterialCap 1 | Out-Null

        # First material request (count = 1 <= MaterialCap 1)
        $env:FAKE_CODEX_SCENARIO = Join-Path $ScenariosDir 'material-required.json'
        $adv1 = & $CollabScript `
            -Command 'advance' -ProjectRoot $tempDir -ReviewId $reviewId `
            -ReviewerExe 'powershell.exe' -ReviewerArgs $reviewerCmdArgs | ConvertFrom-Json

        $adv1.ok | Should Be $true
        $adv1.human_state | Should Be 'waiting-user'
        $adv1.wait_reason | Should Be 'material-decision'
        $adv1.next_action | Should Be 'provide_material_or_unavailable'

        # Submit material-response with valid shape
        $matRespPath = Join-Path $tempDir 'mat-resp.json'
        $matObj = @{
            schema_version = '1.0.0'
            request_id = 'claim-x'
            status = 'provided'
            excerpt = @{
                content = 'Supplementary evidence excerpt'
                source_locator = 'docs/planB-task-spec.md:20'
            }
        } | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($matRespPath, $matObj, (New-Object System.Text.UTF8Encoding $false))

        $subMat = & $CollabScript `
            -Command 'submit' -ProjectRoot $tempDir -ReviewId $reviewId `
            -Kind 'material-response' -InputFile $matRespPath | ConvertFrom-Json

        $subMat.ok | Should Be $true
        $subMat.human_state | Should Be 'reviewing'

        # Second material request (usedSoFar=1 + 1 > MaterialCap 1 -> cap reached)
        $adv2 = & $CollabScript `
            -Command 'advance' -ProjectRoot $tempDir -ReviewId $reviewId `
            -ReviewerExe 'powershell.exe' -ReviewerArgs $reviewerCmdArgs | ConvertFrom-Json

        if (-not $adv2.ok) { Write-Host ("adv2 failed: " + $adv2.error) }
        $adv2.ok | Should Be $true
        $adv2.human_state | Should Be 'waiting-user'
        $adv2.wait_reason | Should Be 'arbitration'
        $adv2.next_action | Should Be 'choose_arbitration'
    }

    It 'Scenario 4: Fatal technical failure leads to resolve_manual_recovery' {
        $reviewId = 'rev-sim-fail'

        & $CollabScript `
            -Command 'confirm-package' -ProjectRoot $tempDir -ReviewId $reviewId `
            -PackageFile $SamplePackage -Cap 5 -MaterialCap 3 | Out-Null

        # Nonzero exit code triggers manual_recovery_required
        $env:FAKE_CODEX_SCENARIO = Join-Path $ScenariosDir 'nonzero-exit.json'
        $advFail = & $CollabScript `
            -Command 'advance' -ProjectRoot $tempDir -ReviewId $reviewId `
            -ReviewerExe 'powershell.exe' -ReviewerArgs $reviewerCmdArgs | ConvertFrom-Json

        $advFail.ok | Should Be $false
        $advFail.human_state | Should Be 'waiting-user'
        $advFail.wait_reason | Should Be 'manual-recovery'
        $advFail.next_action | Should Be 'resolve_manual_recovery'
    }
}
