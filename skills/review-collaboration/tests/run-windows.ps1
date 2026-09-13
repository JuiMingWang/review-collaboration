# Windows suite for the ACP mail candidate.
#
# ProcessOwnership covers W01: when a turn times out, every process this run
# created - the Node helper, the reviewer endpoint, and the endpoint's own
# descendants - must be gone, and the receipt must say so.
#
# Regression covers the two ways a runner can lie about a run: reading an
# earlier run's output as this run's result, and hanging forever instead of
# failing.
#
# Each case is launched as its own process under a time limit. Killing that
# process closes the transport's job handle, which terminates the whole owned
# tree with it, so no process is ever hunted down by name. The evidence
# directory must be new: earlier results are evidence and are never deleted.
[CmdletBinding()]
param(
    [ValidateSet('ProcessOwnership', 'Regression', 'All')][string]$Suite = 'All',
    [Parameter(Mandatory = $true)][string]$EvidenceRoot,
    [int]$CaseLimitMs = 180000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

$testsRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$packageRoot = [IO.Path]::GetFullPath((Join-Path $testsRoot '..'))
$fixture = Join-Path $testsRoot 'fixtures\acp-fixture.mjs'
$mailScript = Join-Path $packageRoot 'scripts\review-mail.ps1'
$utf8 = New-Object Text.UTF8Encoding($false)
$OutputEncoding = $utf8

$evidenceFull = [IO.Path]::GetFullPath($EvidenceRoot)
if (Test-Path -LiteralPath $evidenceFull) {
    [Console]::Error.WriteLine("evidence root already exists, refusing to overwrite earlier results: $evidenceFull")
    exit 65
}
New-Item -ItemType Directory -Path $evidenceFull -Force | Out-Null
# Keep synthetic route caches out of the actual candidate's preferences. Node
# resolves the installed SDK through the ancestor candidate node_modules.
$testPackage = Join-Path $packageRoot ('_private\windows-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $testPackage | Out-Null
Copy-Item -LiteralPath (Join-Path $packageRoot 'scripts') -Destination (Join-Path $testPackage 'scripts') -Recurse
$mailScript = Join-Path $testPackage 'scripts\review-mail.ps1'

$script:cases = @()
$script:runnerError = $null
$startedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

function Get-Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

# A missing or malformed file must turn into a failed case, never into an
# aborted run that writes no results at all.
function Read-JsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function New-CaseDirectory([string]$CaseId) {
    $path = Join-Path $evidenceFull $CaseId
    if (Test-Path -LiteralPath $path) { throw "case-directory-exists:$CaseId" }
    New-Item -ItemType Directory -Path $path | Out-Null
    return $path
}

function Read-EventLog([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
    return @(Get-Content -LiteralPath $Path -Encoding UTF8 | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_ | ConvertFrom-Json })
}

function Get-FileSha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

# Runs one child under a time limit. On expiry the child is killed; because the
# transport's job is closed with it, its whole owned tree goes too.
#
# Reading the child's output is bounded as well. Waiting on the read tasks
# without a limit would reintroduce the hang the limit exists to prevent, so an
# unfinished read ends this run's process and is recorded as a failure - empty
# output is never passed off as output.
function Start-Bounded([string]$FileName, [string[]]$Arguments, [int]$LimitMs, [string]$LogPrefix) {
    $drainLimitMs = 5000

    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $FileName
    $psi.Arguments = (($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $utf8
    $psi.StandardErrorEncoding = $utf8

    $began = Get-Date
    $proc = [Diagnostics.Process]::Start($psi)
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    $exitedInTime = $proc.WaitForExit($LimitMs)
    $killed = $false
    if (-not $exitedInTime) {
        try { $proc.Kill() } catch { }
        $killed = $true
        $null = $proc.WaitForExit(15000)
    }

    $drained = [Threading.Tasks.Task]::WaitAll(@($outTask, $errTask), $drainLimitMs)
    if (-not $drained) {
        # A pipe still held open means something of this run is still alive.
        if (-not $proc.HasExited) {
            try { $proc.Kill() } catch { }
            $killed = $true
        }
        $drained = [Threading.Tasks.Task]::WaitAll(@($outTask, $errTask), 2000)
    }
    $elapsedMs = [int]((Get-Date) - $began).TotalMilliseconds

    if ($drained) {
        [IO.File]::WriteAllText("$LogPrefix.stdout.log", $outTask.Result, $utf8)
        [IO.File]::WriteAllText("$LogPrefix.stderr.log", $errTask.Result, $utf8)
    }
    else {
        [IO.File]::WriteAllText("$LogPrefix.drain-incomplete.txt",
            "stdout and stderr were not fully read within $drainLimitMs ms plus grace; captured output is unavailable for this case", $utf8)
    }

    $exitCode = $null
    if ($exitedInTime) { $exitCode = $proc.ExitCode }
    $proc.Dispose()
    return [ordered]@{ exit_code = $exitCode; exited_within_limit = $exitedInTime; killed = $killed; drain_complete = $drained; drain_limit_ms = $drainLimitMs; elapsed_ms = $elapsedMs }
}

function New-RouteFile([string]$CaseDir, [string]$Scenario, [string]$EventLog) {
    $nodeExe = [IO.Path]::GetFullPath((Get-Command node.exe).Source)
    $inputData = @{directory=$CaseDir;fixture=$fixture;scenario=$Scenario;event_log=$EventLog} | ConvertTo-Json -Compress
    $inputData | & $nodeExe (Join-Path $testsRoot 'fixtures\make-test-route.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'synthetic-route-build-failed' }
    $path = Join-Path $CaseDir 'route.json'
    return $path
}

function New-RequestFile([string]$Path, $Body) {
    [IO.File]::WriteAllText($Path, ($Body | ConvertTo-Json -Depth 8), $utf8)
    return $Path
}

function Invoke-Mail([string]$RequestFile, [string]$OutputDir, [int]$WrapperTimeoutMs, [int]$LimitMs, [string]$LogPrefix) {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $mailScript,
        '-RequestFile', $RequestFile, '-OutputDirectory', $OutputDir, '-TimeoutMs', "$WrapperTimeoutMs")
    $run = Start-Bounded 'powershell.exe' $arguments $LimitMs $LogPrefix
    $run['command'] = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $mailScript -RequestFile $RequestFile -OutputDirectory $OutputDir -TimeoutMs $WrapperTimeoutMs"
    $run['ran_at_utc'] = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    return $run
}

function Add-Case([string]$Id, [string]$Status, [string]$Reason, $Detail) {
    $script:cases += [ordered]@{ id = $Id; status = $Status; reason = $Reason; detail = $Detail }
    "$Id => $Status$(if ($Reason) { " ($Reason)" })"
}

function Test-ProcessAlive([int]$ProcessId) {
    if ($ProcessId -le 0) { return $false }
    return ($null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
}

try {
    if ($Suite -eq 'ProcessOwnership' -or $Suite -eq 'All') {

        # W01: the endpoint spawns a child and a grandchild, then stops answering.
        $caseDir = New-CaseDirectory 'W01'
        $workDir = Join-Path $caseDir 'work'
        New-Item -ItemType Directory -Path $workDir | Out-Null
        $eventLog = Join-Path $caseDir 'fixture-events.jsonl'
        $routeFile = New-RouteFile $caseDir 'hang-with-child' $eventLog
        $requestFile = New-RequestFile (Join-Path $caseDir 'request.json') ([ordered]@{
                schema_version = 1
                action         = 'probe'
                args           = [ordered]@{ route_candidate_file = $routeFile; mode = 'live'; authorization_ref = 'synthetic-windows-ownership' }
            })
        $outputDir = Join-Path $caseDir 'transport-output'
        $run = Invoke-Mail $requestFile $outputDir 9000 $CaseLimitMs (Join-Path $caseDir 'wrapper')

        $receipt = Read-JsonFile (Join-Path $outputDir 'receipt.json')
        $events = Read-EventLog $eventLog
        $spawned = $events | Where-Object { $_.event -eq 'descendants-spawned' } | Select-Object -First 1
        $grandchild = $events | Where-Object { $_.event -eq 'grandchild-spawned' } | Select-Object -First 1
        $cleanup = Get-Field $receipt 'cleanup'

        $problems = @()
        if (-not $run.exited_within_limit) { $problems += 'wrapper-exceeded-case-limit' }
        if (-not $run.drain_complete) { $problems += 'stream-drain-incomplete' }
        if ($null -eq $receipt) { $problems += 'receipt-missing-or-unreadable' }
        if ($null -eq $spawned) { $problems += 'fixture-did-not-report-descendants' }
        if ($null -eq $grandchild) { $problems += 'fixture-did-not-report-grandchild' }
        if ((Get-Field $receipt 'timed_out') -ne $true) { $problems += 'wrapper-did-not-time-out' }
        if ((Get-Field $cleanup 'cleanup_complete') -ne $true) { $problems += 'cleanup-not-complete' }
        if ((Get-Field $cleanup 'owned_processes_remaining') -ne 0) { $problems += 'owned-processes-remaining' }
        if ((Get-Field $cleanup 'job_created') -ne $true) { $problems += 'job-not-created' }
        if ((Get-Field $cleanup 'tree_terminated') -ne $true) { $problems += 'tree-not-terminated' }

        $survivors = @()
        foreach ($entry in @(
                @{ label = 'fixture'; id = $(if ($spawned) { [int]$spawned.fixture_pid } else { 0 }) },
                @{ label = 'child'; id = $(if ($spawned) { [int]$spawned.child_pid } else { 0 }) },
                @{ label = 'grandchild'; id = $(if ($grandchild) { [int]$grandchild.grandchild_pid } else { 0 }) })) {
            if (Test-ProcessAlive $entry.id) { $survivors += "$($entry.label):$($entry.id)" }
        }
        if ($survivors.Count -gt 0) { $problems += "surviving-processes=$($survivors -join ',')" }

        Add-Case 'W01' $(if ($problems.Count -eq 0) { 'pass' } else { 'fail' }) ($problems -join '; ') ([ordered]@{
                timed_out                 = Get-Field $receipt 'timed_out'
                native_exit_code          = Get-Field $receipt 'native_exit_code'
                transport_exit_code       = Get-Field $receipt 'transport_exit_code'
                transport_status          = Get-Field $receipt 'transport_status'
                owned_processes_remaining = Get-Field $cleanup 'owned_processes_remaining'
                cleanup_complete          = Get-Field $cleanup 'cleanup_complete'
                job_created               = Get-Field $cleanup 'job_created'
                tree_terminated           = Get-Field $cleanup 'tree_terminated'
                fixture_pid               = $(if ($spawned) { $spawned.fixture_pid } else { $null })
                child_pid                 = $(if ($spawned) { $spawned.child_pid } else { $null })
                grandchild_pid            = $(if ($grandchild) { $grandchild.grandchild_pid } else { $null })
                surviving_processes       = $survivors
                wrapper                   = $run
            })

        # Initialization is a separate capability level: no session/new/prompt.
        $initDir = New-CaseDirectory 'W-initialize'
        $initEvents = Join-Path $initDir 'fixture-events.jsonl'
        $initRoute = New-RouteFile $initDir 'echo' $initEvents
        $initRequest = New-RequestFile (Join-Path $initDir 'request.json') @{schema_version=1;action='probe';args=@{route_candidate_file=$initRoute;mode='initialize';authorization_ref=$null}}
        $initOutput = Join-Path $initDir 'output'
        $initRun = Invoke-Mail $initRequest $initOutput 60000 $CaseLimitMs (Join-Path $initDir 'wrapper')
        $initResult = Read-JsonFile (Join-Path $initOutput 'mail-result.json')
        $initData = Get-Field $initResult 'data'
        $initMethods = @((Read-EventLog $initEvents) | Where-Object { $_.event -eq 'request' } | ForEach-Object { $_.method })
        $initOK = $initRun.exit_code -eq 0 -and $initRun.drain_complete -and (Get-Field $initData 'level') -eq 'initialized' -and (Get-Field $initData 'prompts_submitted') -eq 0 -and ($initMethods -join ',') -eq 'initialize'
        Add-Case 'W-initialize' $(if($initOK){'pass'}else{'fail'}) $(if($initOK){$null}else{'initialize-contract-failed'}) @{wrapper=$initRun;methods=$initMethods;data=$initData}

        # W01b: the same path must still succeed normally, otherwise "everything
        # was killed" would be indistinguishable from "nothing ever worked".
        $caseDir2 = New-CaseDirectory 'W01b'
        $workDir2 = Join-Path $caseDir2 'work'
        New-Item -ItemType Directory -Path $workDir2 | Out-Null
        $eventLog2 = Join-Path $caseDir2 'fixture-events.jsonl'
        $routeFile2 = New-RouteFile $caseDir2 'echo' $eventLog2
        $requestFile2 = New-RequestFile (Join-Path $caseDir2 'request.json') ([ordered]@{
                schema_version = 1
                action         = 'probe'
                args           = [ordered]@{ route_candidate_file = $routeFile2; mode = 'live'; authorization_ref = 'synthetic-windows-normal' }
            })
        $outputDir2 = Join-Path $caseDir2 'transport-output'
        $run2 = Invoke-Mail $requestFile2 $outputDir2 60000 $CaseLimitMs (Join-Path $caseDir2 'wrapper')

        $receipt2 = Read-JsonFile (Join-Path $outputDir2 'receipt.json')
        $wrapper2 = Read-JsonFile (Join-Path $outputDir2 'mail-result.json')
        $cleanup2 = Get-Field $receipt2 'cleanup'
        $helper2 = Get-Field $wrapper2 'helper_result'
        $data2 = Get-Field $helper2 'data'

        $problems2 = @()
        if (-not $run2.exited_within_limit) { $problems2 += 'wrapper-exceeded-case-limit' }
        if (-not $run2.drain_complete) { $problems2 += 'stream-drain-incomplete' }
        if ($run2.exit_code -ne 0) { $problems2 += "wrapper-exit-$($run2.exit_code)" }
        if ($null -eq $receipt2) { $problems2 += 'receipt-missing-or-unreadable' }
        if ((Get-Field $receipt2 'timed_out') -eq $true) { $problems2 += 'unexpected-timeout' }
        if ((Get-Field $receipt2 'native_exit_code') -ne 0) { $problems2 += "helper-native-exit=$(Get-Field $receipt2 'native_exit_code')" }
        if ((Get-Field $cleanup2 'cleanup_complete') -ne $true) { $problems2 += 'cleanup-not-complete' }
        if ((Get-Field $cleanup2 'owned_processes_remaining') -ne 0) { $problems2 += 'owned-processes-remaining' }
        if ($null -eq $wrapper2) { $problems2 += 'wrapper-result-file-missing' }
        elseif ((Get-Field $wrapper2 'ok') -ne $true) { $problems2 += "wrapper-not-ok:$(Get-Field $wrapper2 'code')" }
        if ((Get-Field $data2 'level') -ne 'live-verified') { $problems2 += "level=$(Get-Field $data2 'level')" }
        if ((Get-Field $data2 'prompts_submitted') -ne 1) { $problems2 += "prompts-submitted=$(Get-Field $data2 'prompts_submitted')" }

        Add-Case 'W01b' $(if ($problems2.Count -eq 0) { 'pass' } else { 'fail' }) ($problems2 -join '; ') ([ordered]@{
                timed_out                 = Get-Field $receipt2 'timed_out'
                native_exit_code          = Get-Field $receipt2 'native_exit_code'
                transport_exit_code       = Get-Field $receipt2 'transport_exit_code'
                cleanup_complete          = Get-Field $cleanup2 'cleanup_complete'
                owned_processes_remaining = Get-Field $cleanup2 'owned_processes_remaining'
                level                     = Get-Field $data2 'level'
                prompts_submitted         = Get-Field $data2 'prompts_submitted'
                reply_bytes               = $(if (Test-Path -LiteralPath (Join-Path $outputDir2 'probe-reply.md')) { (Get-Item -LiteralPath (Join-Path $outputDir2 'probe-reply.md')).Length } else { $null })
                wrapper                   = $run2
            })
    }

    if ($Suite -eq 'Regression' -or $Suite -eq 'All') {

        # W-F01: a second call aimed at an output location that already holds a
        # result must fail, and must leave that earlier result untouched.
        $caseDir3 = New-CaseDirectory 'W-F01-reused-output'
        $workDir3 = Join-Path $caseDir3 'work'
        New-Item -ItemType Directory -Path $workDir3 | Out-Null
        $eventLog3 = Join-Path $caseDir3 'fixture-events.jsonl'
        $routeFile3 = New-RouteFile $caseDir3 'echo' $eventLog3
        $outputDir3 = Join-Path $caseDir3 'transport-output'
        $transportRequest3 = Join-Path $caseDir3 'transport-output.transport-request.json'

        $firstRequest = New-RequestFile (Join-Path $caseDir3 'request-first.json') ([ordered]@{
                schema_version = 1
                action         = 'probe'
                args           = [ordered]@{ route_candidate_file = $routeFile3; mode = 'live'; authorization_ref = 'synthetic-windows-first' }
            })
        $firstRun = Invoke-Mail $firstRequest $outputDir3 60000 $CaseLimitMs (Join-Path $caseDir3 'first')

        $resultPath3 = Join-Path $outputDir3 'mail-result.json'
        $firstResultSha = Get-FileSha256 $resultPath3
        $firstTransportSha = Get-FileSha256 $transportRequest3
        $eventsAfterFirst = Read-EventLog $eventLog3
        $promptsAfterFirst = @($eventsAfterFirst | Where-Object { $_.event -eq 'prompt' }).Count

        # A different action, so a stale result would also be the wrong answer.
        $secondRequest = New-RequestFile (Join-Path $caseDir3 'request-second.json') ([ordered]@{
                schema_version = 1
                action         = 'status'
                args           = [ordered]@{}
            })
        $secondRun = Invoke-Mail $secondRequest $outputDir3 60000 $CaseLimitMs (Join-Path $caseDir3 'second')
        $secondStdoutPath = Join-Path $caseDir3 'second.stdout.log'
        $secondReported = $null
        if (Test-Path -LiteralPath $secondStdoutPath -PathType Leaf) {
            $secondStdout = Get-Content -LiteralPath $secondStdoutPath -Raw -Encoding UTF8
            try { $secondReported = ($secondStdout -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 1) | ConvertFrom-Json } catch { }
        }

        $secondResultSha = Get-FileSha256 $resultPath3
        $secondTransportSha = Get-FileSha256 $transportRequest3
        $promptsAfterSecond = @((Read-EventLog $eventLog3) | Where-Object { $_.event -eq 'prompt' }).Count

        $problems3 = @()
        if ($firstRun.exit_code -ne 0) { $problems3 += "first-call-exit-$($firstRun.exit_code)" }
        if (-not $firstRun.drain_complete) { $problems3 += 'first-call-stream-drain-incomplete' }
        if (-not $secondRun.drain_complete) { $problems3 += 'second-call-stream-drain-incomplete' }
        if ($promptsAfterFirst -ne 1) { $problems3 += "first-call-prompts=$promptsAfterFirst" }
        if ($secondRun.exit_code -eq 0) { $problems3 += 'second-call-succeeded' }
        if ((Get-Field $secondReported 'ok') -ne $false) { $problems3 += 'second-call-did-not-report-failure' }
        if ($secondResultSha -ne $firstResultSha) { $problems3 += 'earlier-result-was-overwritten' }
        if ($secondTransportSha -ne $firstTransportSha) { $problems3 += 'earlier-transport-request-was-overwritten' }
        if ($promptsAfterSecond -ne $promptsAfterFirst) { $problems3 += 'second-call-reached-the-endpoint' }

        Add-Case 'W-F01-reused-output' $(if ($problems3.Count -eq 0) { 'pass' } else { 'fail' }) ($problems3 -join '; ') ([ordered]@{
                first_exit                 = $firstRun.exit_code
                second_exit                = $secondRun.exit_code
                second_reported_ok         = Get-Field $secondReported 'ok'
                second_reported_code       = Get-Field $secondReported 'code'
                second_reported_detail     = Get-Field $secondReported 'detail'
                mail_result_sha256_first   = $firstResultSha
                mail_result_sha256_second  = $secondResultSha
                transport_request_sha256_first  = $firstTransportSha
                transport_request_sha256_second = $secondTransportSha
                prompts_after_first        = $promptsAfterFirst
                prompts_after_second       = $promptsAfterSecond
                first_command              = $firstRun.command
                second_command             = $secondRun.command
            })

        # W-F04: a wrapper that will not return must be stopped by the runner's
        # own limit, and the endpoint tree it owned must go with it.
        $caseDir4 = New-CaseDirectory 'W-F04-runner-deadline'
        $workDir4 = Join-Path $caseDir4 'work'
        New-Item -ItemType Directory -Path $workDir4 | Out-Null
        $eventLog4 = Join-Path $caseDir4 'fixture-events.jsonl'
        $routeFile4 = New-RouteFile $caseDir4 'hang-with-child' $eventLog4
        $requestFile4 = New-RequestFile (Join-Path $caseDir4 'request.json') ([ordered]@{
                schema_version = 1
                action         = 'probe'
                args           = [ordered]@{ route_candidate_file = $routeFile4; mode = 'live'; authorization_ref = 'synthetic-windows-deadline' }
            })
        # The wrapper is told to wait far longer than the runner will, so the
        # runner's limit is what ends this case.
        $runnerLimitMs = 8000
        $run4 = Invoke-Mail $requestFile4 (Join-Path $caseDir4 'transport-output') 600000 $runnerLimitMs (Join-Path $caseDir4 'wrapper')
        Start-Sleep -Milliseconds 1500

        $events4 = Read-EventLog $eventLog4
        $spawned4 = $events4 | Where-Object { $_.event -eq 'descendants-spawned' } | Select-Object -First 1
        $grandchild4 = $events4 | Where-Object { $_.event -eq 'grandchild-spawned' } | Select-Object -First 1
        $survivors4 = @()
        foreach ($entry in @(
                @{ label = 'fixture'; id = $(if ($spawned4) { [int]$spawned4.fixture_pid } else { 0 }) },
                @{ label = 'child'; id = $(if ($spawned4) { [int]$spawned4.child_pid } else { 0 }) },
                @{ label = 'grandchild'; id = $(if ($grandchild4) { [int]$grandchild4.grandchild_pid } else { 0 }) })) {
            if (Test-ProcessAlive $entry.id) { $survivors4 += "$($entry.label):$($entry.id)" }
        }

        $problems4 = @()
        if ($null -eq $spawned4) { $problems4 += 'fixture-did-not-start' }
        if (-not $run4.drain_complete) { $problems4 += 'stream-drain-incomplete' }
        if ($run4.exited_within_limit) { $problems4 += 'wrapper-returned-on-its-own' }
        if (-not $run4.killed) { $problems4 += 'runner-did-not-stop-the-wrapper' }
        if ($run4.elapsed_ms -gt ($runnerLimitMs + 20000)) { $problems4 += "runner-overran=$($run4.elapsed_ms)ms" }
        if ($survivors4.Count -gt 0) { $problems4 += "surviving-processes=$($survivors4 -join ',')" }

        Add-Case 'W-F04-runner-deadline' $(if ($problems4.Count -eq 0) { 'pass' } else { 'fail' }) ($problems4 -join '; ') ([ordered]@{
                runner_limit_ms     = $runnerLimitMs
                elapsed_ms          = $run4.elapsed_ms
                exited_within_limit = $run4.exited_within_limit
                killed_by_runner    = $run4.killed
                fixture_pid         = $(if ($spawned4) { $spawned4.fixture_pid } else { $null })
                child_pid           = $(if ($spawned4) { $spawned4.child_pid } else { $null })
                grandchild_pid      = $(if ($grandchild4) { $grandchild4.grandchild_pid } else { $null })
                surviving_processes = $survivors4
                receipt_present     = (Test-Path -LiteralPath (Join-Path $caseDir4 'transport-output\receipt.json'))
                command             = $run4.command
            })
    }
}
catch {
    $script:runnerError = "$($_.Exception.Message) :: $($_.ScriptStackTrace)"
    Add-Case 'runner-infrastructure' 'fail' $script:runnerError ([ordered]@{})
    "runner-error: $($_.Exception.Message)"
}

$failed = @($script:cases | Where-Object { $_.status -ne 'pass' })
$results = [ordered]@{
    schema_version = 1
    task_id        = 'ACP-MAIL-20260911'
    task           = 'T2-T5-root'
    suite          = $Suite
    started_at     = $startedAt
    ended_at       = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    package_root   = $packageRoot
    case_limit_ms  = $CaseLimitMs
    runner_error   = $script:runnerError
    cases          = $script:cases
    not_implemented_in_this_suite = @('W02 full exchange cancellation covered by mail-exchange.test.mjs', 'W03 special argv data covered by client/mail-exchange tests; cmd launch is explicitly rejected by route validation')
}
$resultsPath = Join-Path $evidenceFull 'results.json'
[IO.File]::WriteAllText($resultsPath, ($results | ConvertTo-Json -Depth 14), $utf8)
"results=$resultsPath"
"failed=$($failed.Count)"
if ($failed.Count -gt 0 -or $null -ne $script:runnerError) { exit 1 }
exit 0
