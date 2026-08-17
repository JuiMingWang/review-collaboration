# CodexAdapter.Tests.ps1
# 驗證 scripts/adapters/codex-adapter.ps1 的介面相容性、固定旗標、BOM-free 與編碼規範。

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TestRoot = $PSScriptRoot
$ProjectRoot = Split-Path $TestRoot -Parent
$AdapterScript = Join-Path $ProjectRoot 'scripts\adapters\codex-adapter.ps1'
$SchemaFile = Join-Path $ProjectRoot 'schemas\reviewer-result.schema.json'
$SamplePackageFile = Join-Path $ProjectRoot 'tests\fixtures\sample-package.md'

Describe 'CodexAdapter Interface and Flag Compliance' {

    It 'reviewer-result.schema.json is confirmed BOM-free UTF-8 on disk' {
        Test-Path $SchemaFile | Should Be $true
        $bytes = [System.IO.File]::ReadAllBytes($SchemaFile)
        $bytes.Length | Should BeGreaterThan 0
        # UTF-8 BOM is 0xEF, 0xBB, 0xBF
        $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
        $hasBom | Should Be $false
    }

    It 'adapter file exists and is readable' {
        Test-Path $AdapterScript | Should Be $true
    }

    It 'rejects missing mandatory parameters' {
        $tempPrompt = [System.IO.Path]::GetTempFileName()
        try {
            # Missing OutFile and EventsFile
            { & $AdapterScript -PromptFile $tempPrompt } | Should Throw
        } finally {
            if (Test-Path $tempPrompt) { Remove-Item $tempPrompt -Force }
        }
    }

    Context 'Mock Codex Execution Testing' {
        $tempDir = $null
        $mockCodexDir = $null

        BeforeEach {
            $tempDir = Join-Path $env:TEMP ("codex-adapter-test-" + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
            $mockCodexDir = Join-Path $tempDir 'mockbin'
            New-Item -ItemType Directory -Path $mockCodexDir -Force | Out-Null

            # 建立 mock codex.cmd。
            # 呼叫 mock-impl.ps1 一律用 -Command "& '<path>' %*"，不能用 -File "<path>" %*——
            # 已用最小重現腳本驗證：codex 實際呼叫尾端固定會帶一個單獨的 "-"（代表用 stdin 餵內容，
            # codex CLI 本身的慣例，整個專案 SKILL.md／codex-adapter.ps1 都這樣用），但 PowerShell
            # 的 -File 參數解析器只要引數清單裡出現單獨一個 "-"，不管在哪個位置，都會讓該腳本的參數
            # 繫結直接丟出 PSArgumentException（"name" 參數的值無效），跟腳本本身有沒有宣告 param()
            # 無關。改用 -Command "& '<path>' %*" 呼叫，同一組引數（含尾端 "-"）就能正常傳遞。
            $mockImplPs1 = Join-Path $mockCodexDir 'mock-impl.ps1'
            $mockCodexCmd = Join-Path $mockCodexDir 'codex.cmd'

            $cmdContent = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -Command `"& '$mockImplPs1' %*`""
            [System.IO.File]::WriteAllText($mockCodexCmd, $cmdContent, (New-Object System.Text.UTF8Encoding $false))

            # ASCII-only comments below are intentional, not a style choice: this heredoc gets written to
            # disk as BOM-free UTF-8 (see WriteAllText call below) and then executed directly as a .ps1
            # via bare command-line invocation relying on $args (no param() block). Empirically confirmed
            # (minimal repro, 2026-08-17): a BOM-free UTF-8 .ps1 invoked this way that contains non-ASCII
            # (e.g. Traditional Chinese) characters anywhere near the top causes PowerShell 5.1 to silently
            # bind $args as empty — not a decode/mojibake symptom, a parser-level argument-binding failure.
            # Removing the non-ASCII text (this comment included) is the fix; also do not declare a param()
            # block with [Parameter(...)] here, since that separately triggers AmbiguousParameter against
            # -OutVariable/-OutBuffer when codex's own -o flag is passed through.
            $ps1Content = @'
$ArgsList = $args
$logDir = $env:MOCK_CODEX_LOG_DIR
if ($logDir -and (Test-Path $logDir)) {
    $argsFile = Join-Path $logDir 'args.json'
    $stdinFile = Join-Path $logDir 'stdin.txt'
    
    $argsArray = @($ArgsList)
    $argsJson = $argsArray | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($argsFile, $argsJson, (New-Object System.Text.UTF8Encoding $false))

    $stdinContent = [Console]::In.ReadToEnd()
    [System.IO.File]::WriteAllText($stdinFile, $stdinContent, (New-Object System.Text.UTF8Encoding $false))

    # Parse -o argument to simulate writing valid reviewer result
    for ($i = 0; $i -lt $argsArray.Count; $i++) {
        if ($argsArray[$i] -eq '-o' -and ($i + 1) -lt $argsArray.Count) {
            $outPath = $argsArray[$i + 1]
            $dummyResult = @{
                schema_version = '1.0.0'
                outcome = 'CONSENSUS'
                narrative = 'mock consensus'
                dispositions = @()
                new_issues = @()
                advisories = @()
                material_requests = @()
            } | ConvertTo-Json -Depth 5
            [System.IO.File]::WriteAllText($outPath, $dummyResult, (New-Object System.Text.UTF8Encoding $false))
        }
    }

    # Emit standard events to stdout
    $effectiveThread = 'thread-mock-123'
    for ($i = 0; $i -lt $argsArray.Count; $i++) {
        if ($argsArray[$i] -eq 'resume' -and ($i + 1) -lt $argsArray.Count) {
            $effectiveThread = $argsArray[$i + 1]
        }
    }
    Write-Output (@{ type = 'thread.started'; thread_id = $effectiveThread } | ConvertTo-Json -Compress)
    Write-Output (@{ type = 'turn.completed' } | ConvertTo-Json -Compress)
}
exit 0
'@
            [System.IO.File]::WriteAllText($mockImplPs1, $ps1Content, (New-Object System.Text.UTF8Encoding $false))
        }

        AfterEach {
            if ($tempDir -and (Test-Path $tempDir)) {
                Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        It 'executes round 1 without resume and passes all mandatory flags and UTF8 prompt' {
            $env:MOCK_CODEX_LOG_DIR = $tempDir
            $oldPath = $env:PATH
            $env:PATH = "$mockCodexDir;$oldPath"

            try {
                $promptPath = Join-Path $tempDir 'prompt_r1.txt'
                $outPath = Join-Path $tempDir 'out_r1.json'
                $eventsPath = Join-Path $tempDir 'events_r1.jsonl'
                $testPrompt = "Prompt Content - Round 1`n## Checklist`n- Point 1"
                [System.IO.File]::WriteAllText($promptPath, $testPrompt, (New-Object System.Text.UTF8Encoding $false))

                & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $AdapterScript `
                    -PromptFile $promptPath -OutFile $outPath -EventsFile $eventsPath

                $LASTEXITCODE | Should Be 0

                # Verify args captured
                $argsJsonPath = Join-Path $tempDir 'args.json'
                Test-Path $argsJsonPath | Should Be $true
                $capturedArgs = Get-Content -Raw $argsJsonPath | ConvertFrom-Json

                # Assert exact mandatory flags
                $capturedArgs -contains 'exec' | Should Be $true
                $capturedArgs -contains '--json' | Should Be $true
                $capturedArgs -contains '--ignore-user-config' | Should Be $true
                $capturedArgs -contains '-m' | Should Be $true
                $capturedArgs -contains 'gpt-5.6-sol' | Should Be $true
                $capturedArgs -contains '-c' | Should Be $true
                $capturedArgs -contains 'model_reasoning_effort=high' | Should Be $true
                $capturedArgs -contains '--sandbox' | Should Be $true
                $capturedArgs -contains 'read-only' | Should Be $true
                $capturedArgs -contains '--skip-git-repo-check' | Should Be $true
                $capturedArgs -contains '--output-schema' | Should Be $true
                $capturedArgs -contains '-o' | Should Be $true
                $capturedArgs -contains $outPath | Should Be $true
                $capturedArgs -contains '-' | Should Be $true
                $capturedArgs -contains 'resume' | Should Be $false

                # Verify stdin content is intact
                $stdinPath = Join-Path $tempDir 'stdin.txt'
                Test-Path $stdinPath | Should Be $true
                $capturedStdin = [System.IO.File]::ReadAllText($stdinPath, [System.Text.Encoding]::UTF8)
                $capturedStdin.Trim() | Should Be $testPrompt.Trim()

                # Verify EventsFile has thread.started and turn.completed
                Test-Path $eventsPath | Should Be $true
                $eventsContent = Get-Content -Raw $eventsPath
                $eventsContent | Should Match '"thread\.started"'
                $eventsContent | Should Match '"turn\.completed"'

                # Verify OutFile created
                Test-Path $outPath | Should Be $true
            } finally {
                $env:PATH = $oldPath
                Remove-Item env:MOCK_CODEX_LOG_DIR -ErrorAction SilentlyContinue
            }
        }

        It 'executes subsequent round with resume <ThreadId>' {
            $env:MOCK_CODEX_LOG_DIR = $tempDir
            $oldPath = $env:PATH
            $env:PATH = "$mockCodexDir;$oldPath"

            try {
                $promptPath = Join-Path $tempDir 'prompt_r2.txt'
                $outPath = Join-Path $tempDir 'out_r2.json'
                $eventsPath = Join-Path $tempDir 'events_r2.jsonl'
                $testPrompt = "PRODUCER RESPONSE round 1`n- I0001: FIX_ACCEPTED"
                [System.IO.File]::WriteAllText($promptPath, $testPrompt, (New-Object System.Text.UTF8Encoding $false))

                & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $AdapterScript `
                    -PromptFile $promptPath -OutFile $outPath -EventsFile $eventsPath -ThreadId 'th-existing-999'

                $LASTEXITCODE | Should Be 0

                $argsJsonPath = Join-Path $tempDir 'args.json'
                $capturedArgs = Get-Content -Raw $argsJsonPath | ConvertFrom-Json

                $capturedArgs -contains 'resume' | Should Be $true
                $capturedArgs -contains 'th-existing-999' | Should Be $true
                $capturedArgs -contains '-' | Should Be $true
            } finally {
                $env:PATH = $oldPath
                Remove-Item env:MOCK_CODEX_LOG_DIR -ErrorAction SilentlyContinue
            }
        }

        It 'integrates seamlessly with ReviewerAdapter Invoke-ReviewerCall' {
            $env:MOCK_CODEX_LOG_DIR = $tempDir
            $oldPath = $env:PATH
            $env:PATH = "$mockCodexDir;$oldPath"

            try {
                Import-Module (Join-Path $ProjectRoot 'scripts\lib\StateStore.psm1') -Force
                Import-Module (Join-Path $ProjectRoot 'scripts\lib\Protocol.psm1') -Force
                Import-Module (Join-Path $ProjectRoot 'scripts\lib\ReviewerAdapter.psm1') -Force

                $reviewId = 'rev-adapter-test'
                $packageText = Get-Content -Raw -Path $SamplePackageFile -Encoding UTF8
                Confirm-Package -ProjectRoot $tempDir -ReviewId $reviewId -PackageContent $packageText -Cap 5 | Out-Null
                $state = Get-ReviewState -ProjectRoot $tempDir -ReviewId $reviewId

                $reviewerCmd = @{
                    FilePath = 'powershell.exe'
                    ArgumentList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $AdapterScript)
                }

                $callRes = Invoke-ReviewerCall -ProjectRoot $tempDir -ReviewId $reviewId `
                    -ExpectedRevision $state.revision -Round 1 -PromptText "Test Round 1" `
                    -ReviewerCommand $reviewerCmd

                $callRes.Checkpoint | Should Be 'result_validated'
                $callRes.Result.outcome | Should Be 'CONSENSUS'
                $callRes.ThreadId | Should Be 'thread-mock-123'
            } finally {
                $env:PATH = $oldPath
                Remove-Item env:MOCK_CODEX_LOG_DIR -ErrorAction SilentlyContinue
            }
        }
    }
}
