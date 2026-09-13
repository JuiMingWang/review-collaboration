[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$RequestFile,
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$MaxInputBytes = 1MB
$MaxStreamBytes = 16MB
$scriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$packageRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot '..'))
$baseDirectory = (Get-Location).Path
$createdOutput = $false
$outputFull = $null

function Resolve-Absolute([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'path-required' }
    if ($Value.IndexOf([char]0) -ge 0) { throw 'path-contains-nul' }
    if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
    return [IO.Path]::GetFullPath((Join-Path $baseDirectory $Value))
}
function Assert-JsonNonEmptyString([object]$Value, [string]$Label) {
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$Value)) { throw "$Label-must-be-nonempty-string" }
    $stringValue = [string]$Value
    if ($stringValue.IndexOf([char]0) -ge 0) { throw "$Label-contains-nul" }
    return $stringValue
}
function Assert-JsonInteger([object]$Value, [string]$Label) {
    if ($Value -is [bool] -or $Value -is [single] -or $Value -is [double] -or $Value -is [decimal]) { throw "$Label-must-be-integer-number" }
    if ($Value -isnot [byte] -and $Value -isnot [sbyte] -and $Value -isnot [int16] -and $Value -isnot [uint16] -and $Value -isnot [int32] -and $Value -isnot [uint32] -and $Value -isnot [int64] -and $Value -isnot [uint64]) { throw "$Label-must-be-integer-number" }
    return [int64]$Value
}
function Assert-NoReparseAncestors([string]$Path, [string]$Label, [bool]$AllowMissingLeaf) {
    $cursor = [IO.Path]::GetFullPath($Path)
    if ($AllowMissingLeaf -and -not (Test-Path -LiteralPath $cursor)) { $cursor = Split-Path -Parent $cursor }
    while ($true) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label-reparse-ancestor" }
        $root = [IO.Path]::GetPathRoot($item.FullName)
        if ($item.FullName.TrimEnd('\','/').Equals($root.TrimEnd('\','/'), [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = Split-Path -Parent $item.FullName
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent.Equals($item.FullName, [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = $parent
    }
}
function Assert-ExistingFile([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label-missing" }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer) { throw "$Label-wrong-type" }
    Assert-NoReparseAncestors $item.FullName $Label $false
    return $item.FullName
}
function Assert-ExistingDirectory([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Label-missing" }
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) { throw "$Label-wrong-type" }
    Assert-NoReparseAncestors $item.FullName $Label $false
    return $item.FullName
}
function Assert-OutputDestination([string]$Path) {
    $package = $packageRoot.TrimEnd('\','/')
    $candidate = $Path.TrimEnd('\','/')
    if ($candidate.Equals($package, [StringComparison]::OrdinalIgnoreCase) -or $candidate.StartsWith($package + '\', [StringComparison]::OrdinalIgnoreCase)) {
        # The public wrapper keeps its evidence inside the portable package.
        # Admit only its private operation IDs (including finalization), never
        # arbitrary package/source paths. External output behavior is unchanged.
        $private = Join-Path $package '_private'
        $operations = (Join-Path $private 'operations') + '\'
        if (-not $candidate.StartsWith($operations, [StringComparison]::OrdinalIgnoreCase)) { throw 'output-directory-inside-transport-package' }
        $relative = $candidate.Substring($operations.Length)
        if ($relative -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}(\\finalize)?$') { throw 'output-directory-inside-transport-package' }
        $null = Assert-ExistingDirectory $private 'private-root'
        $ignore = Assert-ExistingFile (Join-Path $private '.gitignore') 'private-ignore'
        if ([IO.File]::ReadAllText($ignore,[Text.Encoding]::UTF8).Trim() -cne '*') { throw 'private-ignore-unverified' }
        $cursor = $package
        while ($cursor) {
            if (Test-Path -LiteralPath (Join-Path $cursor '.git')) {
                $tracked = @(& git -C $cursor ls-files -- $private 2>$null)
                if ($LASTEXITCODE -ne 0) { throw 'private-root-git-unknown' }
                if ($tracked.Count -gt 0) { throw 'private-root-git-tracked' }
                break
            }
            $cursor = [IO.Path]::GetDirectoryName($cursor)
        }
    }
}
function New-Compact([hashtable]$Fields) {
    return ($Fields | ConvertTo-Json -Compress -Depth 12)
}
function Write-Failure([string]$ErrorCode, [string]$Detail) {
    $payload = [ordered]@{ schema_version=1; transport_status='preflight-failure'; error=$ErrorCode; detail=$Detail; transport_only=$true }
    if ($null -ne $outputFull -and $createdOutput) {
        $receiptPath = Join-Path $outputFull 'receipt.json'
        try { [IO.File]::WriteAllText($receiptPath, ($payload | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false))) } catch { }
    }
    [Console]::Out.WriteLine((New-Compact $payload))
}

try {
    $requestFull = Assert-ExistingFile (Resolve-Absolute $RequestFile) 'request-file'
    $requestBytes = [IO.File]::ReadAllBytes($requestFull)
    $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
    $requestText = $strictUtf8.GetString($requestBytes)
    try { $request = $requestText | ConvertFrom-Json -ErrorAction Stop } catch { throw 'malformed-request-json' }
    if ($null -eq $request) { throw 'malformed-request-json' }
    $allowedFields = @('version','executable','arguments','working_directory','stdin_file','timeout_ms')
    foreach ($property in @($request.PSObject.Properties.Name)) { if ($allowedFields -notcontains $property) { throw "unknown-request-field:$property" } }
    foreach ($required in @('version','executable','arguments','working_directory','stdin_file','timeout_ms')) { if (-not ($request.PSObject.Properties.Name -contains $required)) { throw "request-field-required:$required" } }
    $version = Assert-JsonInteger $request.version 'version'
    if ($version -ne 1) { throw 'unsupported-request-version' }
    if ($request.arguments -isnot [Array] -or $request.arguments -is [string]) { throw 'arguments-must-be-array' }
    $arguments = @($request.arguments)
    foreach ($argument in $arguments) {
        if ($argument -isnot [string]) { throw 'arguments-must-contain-strings' }
        if ($argument.IndexOf([char]0) -ge 0) { throw 'arguments-contain-nul' }
    }
    $timeoutMs64 = Assert-JsonInteger $request.timeout_ms 'timeout_ms'
    if ($timeoutMs64 -gt [int]::MaxValue) { throw 'timeout-out-of-range' }
    $timeoutMs = [int]$timeoutMs64
    if ($timeoutMs -lt 1 -or $timeoutMs -gt 86400000) { throw 'timeout-out-of-range' }

    $executableValue = Assert-JsonNonEmptyString $request.executable 'executable'
    $workingValue = Assert-JsonNonEmptyString $request.working_directory 'working-directory'
    $stdinValue = Assert-JsonNonEmptyString $request.stdin_file 'stdin-file'
    $executableFull = Resolve-Absolute $executableValue
    if ([IO.Path]::GetExtension($executableFull) -ine '.exe') { throw 'unsupported-launch-kind-native-exe-required' }
    $executableFull = Assert-ExistingFile $executableFull 'executable'
    $workingFull = Assert-ExistingDirectory (Resolve-Absolute $workingValue) 'working-directory'
    $stdinFull = Assert-ExistingFile (Resolve-Absolute $stdinValue) 'stdin-file'
    $inputInfo = Get-Item -LiteralPath $stdinFull -Force
    if ($inputInfo.Length -gt $MaxInputBytes) { throw 'stdin-too-large' }
    $inputBytes = [IO.File]::ReadAllBytes($stdinFull)
    $null = $strictUtf8.GetString($inputBytes)

    $outputFull = Resolve-Absolute $OutputDirectory
    Assert-OutputDestination $outputFull
    if (Test-Path -LiteralPath $outputFull) { throw 'output-directory-must-be-new' }
    $outputParent = Split-Path -Parent $outputFull
    $null = Assert-ExistingDirectory $outputParent 'output-parent'
    Assert-NoReparseAncestors $outputFull 'output-directory' $true
    New-Item -ItemType Directory -Path $outputFull -ErrorAction Stop | Out-Null
    $createdOutput = $true
    if ((Get-Item -LiteralPath $outputFull -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'output-directory-reparse' }
    foreach ($artifact in @('stdout.bin','stderr.bin','receipt.json')) { if (Test-Path -LiteralPath (Join-Path $outputFull $artifact)) { throw "artifact-already-exists:$artifact" } }

    $source = Join-Path $scriptRoot 'lib\ProcessTransport.cs'
    if ($null -eq ('ReviewCollaboration.Transport.ProcessTransport' -as [type])) {
        Add-Type -TypeDefinition ([IO.File]::ReadAllText($source, [Text.Encoding]::UTF8)) -Language CSharp -ReferencedAssemblies @('System.dll','System.Core.dll') -ErrorAction Stop | Out-Null
    }
    $result = [ReviewCollaboration.Transport.ProcessTransport]::Run($executableFull, [string[]]$arguments, $workingFull, $inputBytes, $outputFull, $timeoutMs, $MaxStreamBytes)
    $receipt = [ordered]@{
        schema_version=1
        transport='shared-windows-native-exe'
        transport_status=$result.Status
        transport_exit_code=$result.WrapperExitCode
        transport_only=$true
        semantic_review_validated=$false
        request_file=$requestFull
        resolved_executable=$executableFull
        resolved_arguments=@($arguments)
        resolved_working_directory=$workingFull
        input_file=$stdinFull
        input_bytes=$result.InputBytes
        input_sha256=$result.InputSha256
        timeout_ms=$timeoutMs
        stream_cap_bytes=$MaxStreamBytes
        process_started=$result.ProcessStarted
        native_exit_code=$result.NativeExitCode
        timed_out=$result.TimedOut
        stdout_truncated=$result.StdoutTruncated
        stderr_truncated=$result.StderrTruncated
        cleanup=[ordered]@{job_created=$result.JobCreated;job_attached=$result.JobAttached;tree_terminated=$result.TreeTerminated;process_exited=$result.ProcessExited;owned_processes_remaining=$result.OwnedProcessesRemaining;stdin_completed=$result.StdinCompleted;stdout_completed=$result.StdoutCompleted;stderr_completed=$result.StderrCompleted;stream_wait_timed_out=$result.StreamWaitTimedOut;cleanup_complete=$result.CleanupComplete}
        capture=[ordered]@{stdout_bytes=$result.StdoutBytes;stderr_bytes=$result.StderrBytes;stdout_error=$result.StdoutError;stderr_error=$result.StderrError;stdin_error=$result.StdinError;launch_error=$result.LaunchError}
        artifacts=[ordered]@{stdout='stdout.bin';stderr='stderr.bin';receipt='receipt.json'}
    }
    $receiptText = $receipt | ConvertTo-Json -Depth 14
    [IO.File]::WriteAllText((Join-Path $outputFull 'receipt.json'), $receiptText, (New-Object Text.UTF8Encoding($false)))
    [Console]::Out.WriteLine(($receipt | ConvertTo-Json -Compress -Depth 14))
    exit ([int]$result.WrapperExitCode)
}
catch {
    Write-Failure 'transport-preflight-or-wrapper-error' $_.Exception.Message
    exit 2
}
