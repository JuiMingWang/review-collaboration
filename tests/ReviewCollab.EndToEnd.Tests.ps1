# ReviewCollab.EndToEnd.Tests.ps1
# 透過 review-collab.ps1 這個單一入口跑整條協議，Reviewer 呼叫全部指到 tests/fixtures/fake-codex.ps1，
# 不會呼叫真正的 codex exe、不花任何真實 Codex 額度——這是唯一被明確允許的 Reviewer 命令來源，
# 全檔案沒有任何一處把 -ReviewerExe 指向真的 codex。
#
# Invoke-Rc 用「雜湊表展開」（@hashtable）呼叫 review-collab.ps1，不是陣列展開（@array）——
# 陣列展開在 PowerShell 裡是照位置塞參數，不會把 '-Command' 這種字串解析成參數名稱
# （連內建的 Get-ChildItem 都是這樣，不是這支腳本特有的行為），實測撞過這個坑才確認。

$RepoRoot = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $RepoRoot 'scripts\lib\StateStore.psm1') -Force
$Script:RcScript = Join-Path $RepoRoot 'scripts\review-collab.ps1'
$Script:FakeCodex = Join-Path $PSScriptRoot 'fixtures\fake-codex.ps1'
$Script:ScenarioDir = Join-Path $PSScriptRoot 'fixtures\scenarios'
$Script:FakeReviewerArgs = @('-NoProfile', '-File', $Script:FakeCodex)

function New-TempProjectRoot {
    $p = Join-Path $env:TEMP ("rc-e2e-" + [Guid]::NewGuid().ToString('N').Substring(0, 10))
    New-Item -ItemType Directory -Path $p -Force | Out-Null
    return $p
}

function New-Rid { "r" + [Guid]::NewGuid().ToString('N').Substring(0, 8) }

function Set-Scenario([string]$Name) {
    $env:FAKE_CODEX_SCENARIO = Join-Path $Script:ScenarioDir $Name
}

function Invoke-Rc {
    <# .SYNOPSIS 呼叫 review-collab.ps1，安全捕捉 crash（不讓單一測試的例外中斷整個測試檔）。
       .PARAMETER Params 雜湊表，key 是不含前導 '-' 的參數名稱，例如 @{ Command='status'; ProjectRoot=$root }。 #>
    param([Parameter(Mandatory)][hashtable]$Params)
    $raw = $null; $threw = $false; $errMsg = $null
    try {
        $raw = & $Script:RcScript @Params 2>&1 | Out-String
    } catch {
        $threw = $true; $errMsg = $_.Exception.Message
    }
    $obj = $null
    if ($raw) { try { $obj = $raw | ConvertFrom-Json } catch { } }
    [pscustomobject]@{ Raw = $raw; Json = $obj; Threw = $threw; ErrorMessage = $errMsg }
}

function New-AdvanceParams([string]$Root, [string]$Rid) {
    @{ Command = 'advance'; ProjectRoot = $Root; ReviewId = $Rid; ReviewerExe = 'powershell.exe'; ReviewerArgs = $Script:FakeReviewerArgs }
}

function New-ValidPackageContent([string]$Conclusion = "Y") {
    @"
# REVIEW PACKAGE
## Problem
p
## Current Conclusion
$Conclusion
## Constraints
none
## Key Assumptions And Verification
- a（可查證且已查證）
## Alternatives Considered
none
## Unknowns
none
## Excluded Content
none
## Checklist
- [x] done
## Ceiling Breaker
none
## Evidence Sources
none
"@
}

function New-ProducerResponseFile([string]$Dir, [int]$Round, [string[]]$OpenIssueIds) {
    $actions = @($OpenIssueIds | ForEach-Object {
        [pscustomobject]@{ issue_id = $_; action = 'fix'; fix_proposal = "address $_"; reviewer_tag_plausible = $true }
    })
    $obj = [pscustomobject]@{ schema_version = '1.0.0'; round = $Round; actions = $actions }
    $path = Join-Path $Dir "producer-response-r$Round.json"
    ($obj | ConvertTo-Json -Depth 10) | Set-Content -Path $path -Encoding UTF8
    return $path
}

function New-HandoffFile([string]$Dir, [string]$ReviewId, [string]$FinalHash) {
    $obj = [pscustomobject]@{
        schema_version = '1.0.0'; review_id = $ReviewId; final_package_hash = $FinalHash
        conclusion_summary = 'test conclusion'
        accepted_fixes = @(); acceptance_criteria = @()
        target_baseline = [pscustomobject]@{ status = 'not-applicable'; kind = 'none' }
        follow_up_required = $false; follow_up_type = 'none'
    }
    $path = Join-Path $Dir "handoff.json"
    ($obj | ConvertTo-Json -Depth 10) | Set-Content -Path $path -Encoding UTF8
    return $path
}

Describe "正常流程：一次 CONSENSUS 直達 ended" {
    It "confirm-package -> advance(CONSENSUS) -> final-package -> final-approval -> handoff -> ended" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8

            $r1 = Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5 }
            $r1.Json.ok | Should Be $true
            $r1.Json.human_state | Should Be 'confirmed-recoverable'

            Set-Scenario 'consensus.json'
            $r2 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r2.Json.ok | Should Be $true
            $r2.Json.human_state | Should Be 'reviewing'
            $r2.Json.next_action | Should Be 'prepare_final_package'

            $finalPkgPath = Join-Path $root "final.md"
            "# FINAL PACKAGE`nY" | Set-Content -Path $finalPkgPath -Encoding UTF8
            $r3 = Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'final-package'; InputFile = $finalPkgPath }
            $r3.Json.ok | Should Be $true
            $r3.Json.human_state | Should Be 'waiting-user'
            $hash = $r3.Json.artifact_refs.final_package_hash
            $hash.Length | Should Be 64

            $approvalPath = Join-Path $root "approval.json"
            (@{ approved_hash = $hash } | ConvertTo-Json) | Set-Content -Path $approvalPath -Encoding UTF8
            $r4 = Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'final-approval'; InputFile = $approvalPath }
            $r4.Json.ok | Should Be $true
            $r4.Json.human_state | Should Be 'reviewing'
            # 2026-08-16 修復的迴歸測試：ok=true 時 error 欄位必須維持空，不能塞進說明文字。
            ([string]::IsNullOrEmpty($r4.Json.error)) | Should Be $true

            $handoffPath = New-HandoffFile -Dir $root -ReviewId $rid -FinalHash $hash
            $r5 = Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'handoff'; InputFile = $handoffPath }
            $r5.Json.ok | Should Be $true
            $r5.Json.human_state | Should Be 'ended'

            $completionPath = $r5.Json.artifact_refs.completion
            (Test-Path $completionPath) | Should Be $true
            $completion = Get-Content -Raw -Path $completionPath -Encoding UTF8 | ConvertFrom-Json
            $completion.ended_reason | Should Be 'consensus-finalized'

            # 獨立重算每個 required_artifacts 的雜湊，不信任腳本自己回報的值。
            foreach ($art in $completion.required_artifacts) {
                $fullPath = Join-Path (Split-Path $completionPath -Parent) $art.relative_path
                $recomputed = (Get-FileHash -Path $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
                $recomputed | Should Be $art.sha256
            }
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe "ISSUES_RAISED -> Producer 回應 -> 下一輪 CONSENSUS（含對稱稽核欄位）" {
    It "round1 ISSUES_RAISED 帶兩個新問題，round2 CONSENSUS 收斂，ledger 記錄 reviewer_tag_disputed" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5 } | Out-Null

            Set-Scenario 'issues-raised.json'
            $r1 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r1.Json.ok | Should Be $true
            $r1.Json.next_action | Should Be 'provide_producer_response'

            $roundsDir = Join-Path $root ".review-collaboration\active\$rid\rounds"
            New-Item -ItemType Directory -Path $roundsDir -Force | Out-Null
            # I0002 標 reviewer_tag_plausible=false，模擬「不同意 Codex 的查證標籤」這個 2026-08-16 補上的對稱稽核案例。
            $respObj = [pscustomobject]@{
                schema_version = '1.0.0'; round = 1
                actions = @(
                    [pscustomobject]@{ issue_id = 'I0001'; action = 'fix'; fix_proposal = '補查證來源'; reviewer_tag_plausible = $true }
                    [pscustomobject]@{ issue_id = 'I0002'; action = 'pushback'; pushback_reason = '已在 ADR 排除'; verification = '可查證且已查證'; reviewer_tag_plausible = $false; reviewer_tag_dispute_reason = 'ADR 已存在可查證，不該標純屬判斷' }
                )
            }
            $respPath = Join-Path $roundsDir "producer-response-r1.json"
            ($respObj | ConvertTo-Json -Depth 10) | Set-Content -Path $respPath -Encoding UTF8
            $rSubmit = Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'producer-response'; InputFile = $respPath }
            $rSubmit.Json.ok | Should Be $true

            Set-Scenario 'consensus-with-open-issues.json'
            $r2 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r2.Json.ok | Should Be $true
            $r2.Json.next_action | Should Be 'prepare_final_package'

            $ledgerPath = $r2.Json.artifact_refs.ledger
            $ledger = Get-Content -Raw -Path $ledgerPath -Encoding UTF8 | ConvertFrom-Json
            $i0002 = $ledger.issues | Where-Object { $_.issue_id -eq 'I0002' }
            $events = @($i0002.history | ForEach-Object { $_.event })
            ($events -contains 'reviewer_tag_disputed') | Should Be $true
            ($events -contains 'conceded') | Should Be $true
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe "MATERIAL_REQUIRED 補件迴圈" {
    It "補件後重打的那一輪，prompt 必須帶上 material-response 內容並延續同一個 thread（2026-08-17 修復的落差：先前完全沒帶）" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5 } | Out-Null

            Set-Scenario 'material-required.json'
            $r1 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r1.Json.ok | Should Be $true
            $r1.Json.wait_reason | Should Be 'material-decision'

            $matRespObj = [pscustomobject]@{
                schema_version = '1.0.0'; request_id = 'claim-x'; status = 'provided'
                excerpt = [pscustomobject]@{ content = 'VERBATIM_MARKER_abc123'; source_locator = 'doc.md#L10' }
            }
            $matRespPath = Join-Path $root "material-response.json"
            ($matRespObj | ConvertTo-Json -Depth 10) | Set-Content -Path $matRespPath -Encoding UTF8
            $rMat = Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'material-response'; InputFile = $matRespPath }
            $rMat.Json.ok | Should Be $true

            # round 2 的 scenario 換成 consensus（帶自己的 threadId），用來同時驗證 thread 是否真的延續：
            # 若 -ThreadId 有正確帶入（resume），假 adapter 會忽略 scenario 自己的 threadId、原樣回顯傳入值。
            Set-Scenario 'consensus.json'
            $r2 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r2.Json.ok | Should Be $true

            $promptR2 = Get-Content -Raw -Path (Join-Path $root ".review-collaboration\active\$rid\rounds\prompt_r1.txt") -Encoding UTF8
            $promptR2 | Should Match 'MATERIAL RESPONSE'
            $promptR2 | Should Match 'VERBATIM_MARKER_abc123'

            $r2Events = Get-Content -Raw -Path (Join-Path $root ".review-collaboration\active\$rid\rounds\r1.events.jsonl") -Encoding UTF8
            $r2Events | Should Match 'fake-thread-material'   # 延續 round 1 的 thread，不是 consensus.json 自己的 fake-thread-consensus。
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "round 在 MATERIAL_REQUIRED 期間不遞增，補件後同一輪繼續到 CONSENSUS" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5 } | Out-Null

            Set-Scenario 'material-required.json'
            $r1 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r1.Json.ok | Should Be $true
            $r1.Json.human_state | Should Be 'waiting-user'
            $r1.Json.wait_reason | Should Be 'material-decision'
            $r1.Json.next_action | Should Be 'provide_material_or_unavailable'

            $stateBefore = Get-Content -Raw -Path (Join-Path $root ".review-collaboration\active\$rid\review-state.json") -Encoding UTF8 | ConvertFrom-Json
            $stateBefore.completed_round | Should Be 0   # MATERIAL_REQUIRED 不是 final outcome，不計入 round。

            $matRespObj = [pscustomobject]@{
                schema_version = '1.0.0'; request_id = 'claim-x'; status = 'provided'
                excerpt = [pscustomobject]@{ content = 'verbatim text supporting claim X'; source_locator = 'doc.md#L10' }
            }
            $matRespPath = Join-Path $root "material-response.json"
            ($matRespObj | ConvertTo-Json -Depth 10) | Set-Content -Path $matRespPath -Encoding UTF8
            $rMat = Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'material-response'; InputFile = $matRespPath }
            $rMat.Json.ok | Should Be $true
            $rMat.Json.human_state | Should Be 'reviewing'

            Set-Scenario 'consensus.json'
            $r2 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r2.Json.ok | Should Be $true
            $r2.Json.next_action | Should Be 'prepare_final_package'

            $stateAfter = Get-Content -Raw -Path (Join-Path $root ".review-collaboration\active\$rid\review-state.json") -Encoding UTF8 | ConvertFrom-Json
            $stateAfter.completed_round | Should Be 1   # 補件後真正收斂的這一輪，才是第一個 completed round。
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe "補件次數上限" {
    It "補件累計次數超過 MaterialCap 時改觸發 waiting-user/arbitration，不再繼續要材料（2026-08-17：SKILL.md 舊機制原本限制全程最多 3 次逐字引用，v1 移植時漏掉這個安全上限，這裡補上迴歸測試）" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5; MaterialCap = 3 } | Out-Null

            # 連續 3 次 MATERIAL_REQUIRED 都應該正常放行（waiting-user/material-decision）。
            for ($i = 1; $i -le 3; $i++) {
                Set-Scenario 'material-required.json'
                $r = Invoke-Rc (New-AdvanceParams $root $rid)
                $r.Json.ok | Should Be $true
                $r.Json.wait_reason | Should Be 'material-decision'

                $matRespObj = [pscustomobject]@{
                    schema_version = '1.0.0'; request_id = 'claim-x'; status = 'provided'
                    excerpt = [pscustomobject]@{ content = "verbatim text round $i"; source_locator = 'doc.md#L10' }
                }
                $matRespPath = Join-Path $root "material-response-$i.json"
                ($matRespObj | ConvertTo-Json -Depth 10) | Set-Content -Path $matRespPath -Encoding UTF8
                $rMat = Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'material-response'; InputFile = $matRespPath }
                $rMat.Json.ok | Should Be $true
            }

            # 第 4 次：累計已經用滿 3 次上限，這次不該再放行給材料要求，應該轉 arbitration。
            Set-Scenario 'material-required.json'
            $r4 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r4.Json.ok | Should Be $true
            $r4.Json.human_state | Should Be 'waiting-user'
            $r4.Json.wait_reason | Should Be 'arbitration'
            $r4.Json.next_action | Should Be 'choose_arbitration'

            $state = Get-Content -Raw -Path (Join-Path $root ".review-collaboration\active\$rid\review-state.json") -Encoding UTF8 | ConvertFrom-Json
            $state.material_requests_used | Should Be 3   # 第 4 次被擋下，不計入累計。
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe "cap 觸發與使用者仲裁" {
    It "連續 ISSUES_RAISED 打到 cap 後進入 waiting-user/arbitration，選擇 abandon 需另外呼叫 terminate" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 2 } | Out-Null

            Set-Scenario 'issues-raised.json'
            $r1 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r1.Json.next_action | Should Be 'provide_producer_response'

            $roundsDir = Join-Path $root ".review-collaboration\active\$rid\rounds"
            New-Item -ItemType Directory -Path $roundsDir -Force | Out-Null
            New-ProducerResponseFile -Dir $roundsDir -Round 1 -OpenIssueIds @('I0001', 'I0002') | Out-Null
            Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'producer-response'; InputFile = (Join-Path $roundsDir 'producer-response-r1.json') } | Out-Null

            Set-Scenario 'issues-raised-maintained.json'
            $r2 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r2.Json.ok | Should Be $true
            $r2.Json.human_state | Should Be 'waiting-user'
            $r2.Json.wait_reason | Should Be 'arbitration'
            $r2.Json.next_action | Should Be 'choose_arbitration'

            $arbPath = Join-Path $root "arb.json"
            (@{ choice = 'abandon' } | ConvertTo-Json) | Set-Content -Path $arbPath -Encoding UTF8
            $rArb = Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'arbitration'; InputFile = $arbPath }
            $rArb.Json.ok | Should Be $true
            $rArb.Json.human_state | Should Be 'waiting-user'   # 還沒真的結束，abandon 只是指路，要另外呼叫 terminate。

            $rTerm = Invoke-Rc @{ Command = 'terminate'; ProjectRoot = $root; ReviewId = $rid; Reason = 'abandoned' }
            $rTerm.Json.ok | Should Be $true
            $rTerm.Json.human_state | Should Be 'ended'
            $completion = Get-Content -Raw -Path $rTerm.Json.artifact_refs.completion -Encoding UTF8 | ConvertFrom-Json
            $completion.ended_reason | Should Be 'abandoned'
            $completion.final_package_ref | Should Be $null
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "選擇 increase-cap 後：重用既有 ISSUES_RAISED 續行路徑，不強制重新 confirm-package，round3 能正常送出（2026-08-17 修復死路 bug 的迴歸測試）" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 2 } | Out-Null

            Set-Scenario 'issues-raised.json'
            Invoke-Rc (New-AdvanceParams $root $rid) | Out-Null
            $roundsDir = Join-Path $root ".review-collaboration\active\$rid\rounds"
            New-Item -ItemType Directory -Path $roundsDir -Force | Out-Null
            New-ProducerResponseFile -Dir $roundsDir -Round 1 -OpenIssueIds @('I0001', 'I0002') | Out-Null
            Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'producer-response'; InputFile = (Join-Path $roundsDir 'producer-response-r1.json') } | Out-Null

            Set-Scenario 'issues-raised-maintained.json'
            Invoke-Rc (New-AdvanceParams $root $rid) | Out-Null   # round2 ISSUES_RAISED，completed_round(2)==cap(2) -> waiting-user/arbitration

            $arbPath = Join-Path $root "arb.json"
            (@{ choice = 'increase-cap'; additional_rounds = 2 } | ConvertTo-Json) | Set-Content -Path $arbPath -Encoding UTF8
            $rArb = Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'arbitration'; InputFile = $arbPath }
            $rArb.Json.ok | Should Be $true
            # 修復前這裡是 waiting-user/package-reconfirmation，強制回頭重新 confirm-package，
            # 之後 round3 的 advance 永遠卡在要求一個不可能存在的 producer-response-r2.json（死路，
            # 見 2026-08-16 稍早用 Set-TestInconclusive 記錄的設計缺口）。修復後直接回到 reviewing，
            # 跟一般 ISSUES_RAISED 續行完全同一條（已測試過的）路徑。
            $rArb.Json.human_state | Should Be 'reviewing'
            # 這裡是 '' 不是 $null：Write-Result 的 -WaitReason 參數型別是 [string]，沒帶這個參數時
            # PowerShell 對 [string] 型別套用預設值 $null 會被轉型成空字串，不是真正的 JSON null——
            # 這是整支腳本既有、每個「human_state 非 waiting-user 時省略 -WaitReason」的呼叫都會有的
            # 既存輸出外觀（跟這次 cap 修復無關，持久化的 review-state.json 裡的 wait_reason 欄位不受影響，
            # 仍然是真正的 $null，只有這層 CLI 回傳 JSON 的外觀如此），如實比對現況，不是新引入的行為。
            $rArb.Json.wait_reason | Should Be ''
            $rArb.Json.next_action | Should Be 'provide_producer_response'

            # round2 是觸發 cap 那輪，本來就是 ISSUES_RAISED，本來就該補一份 producer-response-r2.json
            # 才能送出 round3——這是既有（已測試過的）流程規則，不是為了繞過死路新造的步驟。
            New-ProducerResponseFile -Dir $roundsDir -Round 2 -OpenIssueIds @('I0001', 'I0002') | Out-Null
            Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'producer-response'; InputFile = (Join-Path $roundsDir 'producer-response-r2.json') } | Out-Null

            # 用 consensus-with-open-issues.json 而非 consensus.json：這裡帶著 round2 留下的兩個 open
            # issue（I0001/I0002），round3 的 Reviewer 結果必須對每個 open issue 都給 disposition
            # 才能通過 Test-ReviewerResult 的交叉驗證，空 dispositions 的 consensus.json 在這裡對不上。
            Set-Scenario 'consensus-with-open-issues.json'
            $r3 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r3.Json.ok | Should Be $true
            $r3.Json.human_state | Should Be 'reviewing'
            $r3.Json.next_action | Should Be 'prepare_final_package'

            $state = Get-Content -Raw -Path (Join-Path $root ".review-collaboration\active\$rid\review-state.json") -Encoding UTF8 | ConvertFrom-Json
            $state.completed_round | Should Be 3
            $state.cap | Should Be 4   # New-IncreasedCap: 觸發時的 completed_round(2) + additional_rounds(2)
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe "錯誤流程：Reviewer 呼叫的各種失敗形態" {
    It "非零 exit code 直接進 manual_recovery_required（不做 protocol repair 重試，那是給 schema 錯誤用的）" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5 } | Out-Null

            Set-Scenario 'nonzero-exit.json'
            $r1 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r1.Json.ok | Should Be $false
            $r1.Json.human_state | Should Be 'waiting-user'
            $r1.Json.wait_reason | Should Be 'manual-recovery'
            $r1.Json.checkpoint | Should Be 'manual_recovery_required'
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "持續回傳無法解析的 JSON：固定重試一次仍失敗後轉 manual_recovery_required" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5 } | Out-Null

            Set-Scenario 'malformed-json.json'
            $r1 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r1.Json.ok | Should Be $false
            # checkpoint 欄位如實反映「最後一次嘗試」本身的技術 checkpoint（重試後仍是
            # reviewer_protocol_repair_required），真正代表「已經轉入 manual-recovery」的
            # 權威訊號是 wait_reason／next_action，不是 checkpoint 這個值本身。
            $r1.Json.checkpoint | Should Be 'reviewer_protocol_repair_required'
            $r1.Json.wait_reason | Should Be 'manual-recovery'
            $r1.Json.next_action | Should Be 'resolve_manual_recovery'
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "沒有送出 turn.completed 事件：同樣視為 protocol repair 失敗，轉 manual_recovery_required" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5 } | Out-Null

            Set-Scenario 'missing-completion.json'
            $r1 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r1.Json.ok | Should Be $false
            $r1.Json.wait_reason | Should Be 'manual-recovery'
            $r1.Json.next_action | Should Be 'resolve_manual_recovery'
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "round2 dispositions 指到一個不存在的 issue_id：交叉驗證失敗，轉 manual_recovery_required" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5 } | Out-Null

            Set-Scenario 'issues-raised.json'
            Invoke-Rc (New-AdvanceParams $root $rid) | Out-Null
            $roundsDir = Join-Path $root ".review-collaboration\active\$rid\rounds"
            New-Item -ItemType Directory -Path $roundsDir -Force | Out-Null
            New-ProducerResponseFile -Dir $roundsDir -Round 1 -OpenIssueIds @('I0001', 'I0002') | Out-Null
            Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'producer-response'; InputFile = (Join-Path $roundsDir 'producer-response-r1.json') } | Out-Null

            Set-Scenario 'mismatched-dispositions.json'
            $r2 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r2.Json.ok | Should Be $false
            $r2.Json.wait_reason | Should Be 'manual-recovery'
            $r2.Json.next_action | Should Be 'resolve_manual_recovery'
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "沒有出現 thread.started 事件時，目前設計不會擋下來——記錄實際行為，不是假設它會失敗" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5 } | Out-Null

            Set-Scenario 'missing-thread-event.json'
            $r1 = Invoke-Rc (New-AdvanceParams $root $rid)
            $r1.Json.ok | Should Be $true   # 目前行為：這一輪照樣成功，thread_id 留空。
            $state = Get-Content -Raw -Path (Join-Path $root ".review-collaboration\active\$rid\review-state.json") -Encoding UTF8 | ConvertFrom-Json
            ([string]::IsNullOrEmpty($state.current_thread_id)) | Should Be $true
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe "幂等性：重送已經處理過的請求不應該讓狀態損壞" {
    It "human_state=waiting-user 時重複呼叫 advance 兩次，兩次都乾淨地回報 blocked，不改變 state" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5 } | Out-Null
            Set-Scenario 'material-required.json'
            Invoke-Rc (New-AdvanceParams $root $rid) | Out-Null

            $statePath = Join-Path $root ".review-collaboration\active\$rid\review-state.json"
            $revBefore = (Get-Content -Raw -Path $statePath -Encoding UTF8 | ConvertFrom-Json).revision

            $rA = Invoke-Rc (New-AdvanceParams $root $rid)
            $rB = Invoke-Rc (New-AdvanceParams $root $rid)
            $rA.Json.ok | Should Be $true
            $rA.Json.error | Should Be 'blocked-on-user: call submit first'
            $rB.Json.error | Should Be 'blocked-on-user: call submit first'

            $revAfter = (Get-Content -Raw -Path $statePath -Encoding UTF8 | ConvertFrom-Json).revision
            $revAfter | Should Be $revBefore
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "重複用相同內容呼叫 confirm-package 不會出錯，package hash 保持一致" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            $r1 = Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5 }
            $r2 = Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5 }
            $r1.Json.ok | Should Be $true
            $r2.Json.ok | Should Be $true
            $state = Get-Content -Raw -Path (Join-Path $root ".review-collaboration\active\$rid\review-state.json") -Encoding UTF8 | ConvertFrom-Json
            # 注意：這裡不能用 Get-FileHash 直接比對 $pkgPath 的原始位元組——package_hash 是腳本對
            # 「讀回的字串內容」算的 SHA-256（Read-Utf8 會把 BOM 去掉），而我這裡用 Set-Content -Encoding UTF8
            # 寫出的檔案本身帶 BOM，兩者位元組不同但語意內容相同；要用同一套「字串內容」邏輯獨立驗證，
            # 不是照抄 Get-FileHash 硬套（第一版測試就是因為這樣算出兩個不同雜湊，誤判成 bug）。
            $state.current_package_ref.package_hash | Should Be (Get-StringSha256 -Text (Read-Utf8 -Path $pkgPath))
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe "中斷／恢復：操作中途失敗不應該讓 state 卡在半寫入狀態" {
    It "review-state.json 遺失時，advance 給出明確的 not-initialized 錯誤而不是內部崩潰" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $r = Invoke-Rc (New-AdvanceParams $root $rid)
            $r.Threw | Should Be $false
            $r.Json.ok | Should Be $false
            $r.Json.error | Should Be 'not-initialized: call confirm-package first'
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It "鎖被其他程序占用時，advance 回報乾淨的 JSON 而不是崩潰或損壞 state（2026-08-16 實測抓到的 bug 迴歸測試：修復前這裡會對 `$null` 物件設定屬性而未捕捉例外地崩潰）" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5 } | Out-Null

            $foreignLock = Enter-ReviewLock -ProjectRoot $root -ReviewId $rid -TimeoutMs 0
            try {
                $revBefore = (Get-Content -Raw -Path (Join-Path $root ".review-collaboration\active\$rid\review-state.json") -Encoding UTF8 | ConvertFrom-Json).revision
                Set-Scenario 'consensus.json'
                $r = Invoke-Rc (New-AdvanceParams $root $rid)
                # 鎖被整段測試持續佔用：Invoke-ReviewerCall 內第一次取鎖（5 秒逾時）失敗後，
                # review-collab.ps1 自己還會再嘗試取鎖一次來記錄 manual-recovery 標記（也 5 秒逾時），
                # 兩次都失敗時必須乾淨地回報，不能崩潰、也不能繞過鎖直接寫 state。
                $r.Threw | Should Be $false
                $r.Json.ok | Should Be $false
                $r.Json.checkpoint | Should Be 'manual_recovery_required'
                $r.Json.error | Should Be 'review-busy: could not persist manual-recovery marker'
                $revAfter = (Get-Content -Raw -Path (Join-Path $root ".review-collaboration\active\$rid\review-state.json") -Encoding UTF8 | ConvertFrom-Json).revision
                $revAfter | Should Be $revBefore   # 兩次都沒拿到鎖，state 完全沒被動過。
            } finally { Exit-ReviewLock -Lock $foreignLock }
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe "被審查目標永不被修改" {
    It "整條流程跑完後，.review-collaboration 資料夾以外的既有檔案（模擬的『被審查目標』）內容完全不變" {
        $root = New-TempProjectRoot
        $rid = New-Rid
        try {
            $targetPath = Join-Path $root "target-source-code.txt"
            $targetContent = "this simulates the actual code/doc under review; must never be touched"
            $targetContent | Set-Content -Path $targetPath -Encoding UTF8 -NoNewline
            $targetHashBefore = (Get-FileHash -Path $targetPath -Algorithm SHA256).Hash

            $pkgPath = Join-Path $root "package.md"
            (New-ValidPackageContent) | Set-Content -Path $pkgPath -Encoding UTF8
            $rc1 = Invoke-Rc @{ Command = 'confirm-package'; ProjectRoot = $root; ReviewId = $rid; PackageFile = $pkgPath; Cap = 5 }
            $rc1.Json.ok | Should Be $true
            Set-Scenario 'consensus.json'
            $rc2 = Invoke-Rc (New-AdvanceParams $root $rid)
            $rc2.Json.ok | Should Be $true
            $finalPkgPath = Join-Path $root "final.md"
            "# FINAL PACKAGE`nY" | Set-Content -Path $finalPkgPath -Encoding UTF8
            $r3 = Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'final-package'; InputFile = $finalPkgPath }
            $r3.Json.ok | Should Be $true
            $hash = $r3.Json.artifact_refs.final_package_hash
            $approvalPath = Join-Path $root "approval.json"
            (@{ approved_hash = $hash } | ConvertTo-Json) | Set-Content -Path $approvalPath -Encoding UTF8
            $r4 = Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'final-approval'; InputFile = $approvalPath }
            $r4.Json.ok | Should Be $true
            $handoffPath = New-HandoffFile -Dir $root -ReviewId $rid -FinalHash $hash
            $r5 = Invoke-Rc @{ Command = 'submit'; ProjectRoot = $root; ReviewId = $rid; Kind = 'handoff'; InputFile = $handoffPath }
            $r5.Json.ok | Should Be $true
            $r5.Json.human_state | Should Be 'ended'

            $targetHashAfter = (Get-FileHash -Path $targetPath -Algorithm SHA256).Hash
            $targetHashAfter | Should Be $targetHashBefore
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
