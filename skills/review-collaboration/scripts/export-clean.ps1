[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)][string]$Destination
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This is deliberately an individual-file allowlist. Adding a public file requires
# updating this list and its export test; no directory or glob is copied.
$PublicAllowlist = @(
    'LICENSE',
    'README.md',
    'SKILL.md',
    'package.json',
    'package-lock.json',
    'references/data-boundaries.md',
    'references/first-connection.md',
    'references/mail-records.md',
    'references/reviewer-discovery.md',
    'references/verification.md',
    'templates/background.md',
    'templates/request.md',
    'templates/handoff.md',
    'scripts/export-clean.ps1',
    'scripts/invoke-process.ps1',
    'scripts/review-mail.mjs',
    'scripts/review-mail.ps1',
    'scripts/lib/ProcessTransport.cs',
    'scripts/lib/ArgvLauncher.cs',
    'scripts/lib/build-argv-launcher.ps1',
    'scripts/lib/argv-launcher.mjs',
    'scripts/lib/LockTransaction.cs',
    'scripts/lib/build-lock-helper.ps1',
    'scripts/lib/windows-lock.mjs',
    'scripts/lib/safe-files.mjs',
    'scripts/lib/mail-contract.mjs',
    'scripts/lib/mail-store.mjs',
    'scripts/lib/reviewer-profile.mjs',
    'scripts/lib/acp-route.mjs',
    'scripts/lib/acp-client.mjs',
    'scripts/lib/mail-exchange.mjs',
    'tests/run-offline.mjs',
    'tests/run-windows.ps1',
    'tests/acp-client.test.mjs',
    'tests/acp-auth.test.mjs',
    'tests/argv-launcher.test.mjs',
    'tests/acp-lifecycle.test.mjs',
    'tests/mail-store.test.mjs',
    'tests/mail-exchange.test.mjs',
    'tests/profile-route.test.mjs',
    'tests/safe-files.test.mjs',
    'tests/runner-guard.test.mjs',
    'tests/export.test.mjs',
    'tests/fixtures/acp-fixture.mjs',
    'tests/fixtures/fresh-host.md',
    'tests/fixtures/make-test-route.mjs',
    'tests/fixtures/profile-writer.mjs',
    'tests/fixtures/store-worker.mjs'
)

function Get-FullPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'path-empty' }
    return [IO.Path]::GetFullPath($Path)
}

function Get-TrimmedPath([string]$Path) {
    $full = Get-FullPath $Path
    $root = [IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { return $full.TrimEnd('\','/') }
    return $root
}

function Test-PathWithin([string]$Parent,[string]$Candidate) {
    $parentFull = Get-TrimmedPath $Parent
    $candidateFull = Get-TrimmedPath $Candidate
    if ($candidateFull.Equals($parentFull,[StringComparison]::OrdinalIgnoreCase)) { return $true }
    $separator = if ($parentFull.EndsWith('\') -or $parentFull.EndsWith('/')) { '' } else { '\' }
    return $candidateFull.StartsWith($parentFull + $separator,[StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoExistingReparseChain([string]$Path,[string]$Label) {
    $probe = Get-FullPath $Path
    while ($true) {
        if (Test-Path -LiteralPath $probe -PathType Any) {
            $item = Get-Item -LiteralPath $probe -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Label-reparse:$probe"
            }
        }
        $parent = [IO.Directory]::GetParent($probe)
        if ($null -eq $parent) { break }
        $parentPath = $parent.FullName
        if ($parentPath.Equals($probe,[StringComparison]::OrdinalIgnoreCase)) { break }
        $probe = $parentPath
    }
}

function Assert-SafeRelativePath([string]$RelativePath) {
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath)) {
        throw "allowlist-path-invalid:$RelativePath"
    }
    if ($RelativePath.Contains('\') -or $RelativePath.Contains(':')) {
        throw "allowlist-path-invalid:$RelativePath"
    }
    foreach ($segment in $RelativePath.Split('/')) {
        if ([string]::IsNullOrWhiteSpace($segment) -or $segment -eq '.' -or $segment -eq '..' -or
            $segment.IndexOfAny([char[]]([char]0,[char]1,[char]2,[char]3,[char]4,[char]5,[char]6,[char]7,[char]8,[char]9,[char]10,[char]11,[char]12,[char]13,[char]14,[char]15,[char]16,[char]17,[char]18,[char]19,[char]20,[char]21,[char]22,[char]23,[char]24,[char]25,[char]26,[char]27,[char]28,[char]29,[char]30,[char]31)) -ge 0) {
            throw "allowlist-path-invalid:$RelativePath"
        }
    }
}

function Get-RelativeFullPath([string]$Root,[string]$RelativePath) {
    Assert-SafeRelativePath $RelativePath
    $candidate = Get-FullPath (Join-Path $Root ($RelativePath -replace '/','\'))
    if (-not (Test-PathWithin $Root $candidate) -or $candidate.Equals((Get-TrimmedPath $Root),[StringComparison]::OrdinalIgnoreCase)) {
        throw "allowlist-path-escape:$RelativePath"
    }
    return $candidate
}

function Remove-OwnedStaging([string]$Path,[string]$Parent) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Container)) { return }
    $full = Get-TrimmedPath $Path
    if (-not (Test-PathWithin $Parent $full) -or (Split-Path -Leaf $full) -notmatch '^\.review-integrated-export-[a-f0-9]{32}$') { return }
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
}

function Test-NoReparseSubtree([string]$Path) {
    $rootItem = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction Stop)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
    }
    return $true
}

$stage = $null
$destinationParent = $null
try {
    $sourceFull = Get-TrimmedPath $SourceRoot
    $destinationFull = Get-TrimmedPath $Destination
    if (-not (Test-Path -LiteralPath $sourceFull -PathType Container)) { throw 'source-missing-or-not-directory' }
    Assert-NoExistingReparseChain $sourceFull 'source'
    if ($sourceFull.Equals($destinationFull,[StringComparison]::OrdinalIgnoreCase) -or
        (Test-PathWithin $sourceFull $destinationFull) -or (Test-PathWithin $destinationFull $sourceFull)) {
        throw 'source-destination-overlap'
    }
    if (Test-Path -LiteralPath $destinationFull -PathType Any) { throw 'destination-already-exists' }
    $destinationParent = [IO.Directory]::GetParent($destinationFull)
    if ($null -eq $destinationParent -or -not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
        throw 'destination-parent-missing'
    }
    Assert-NoExistingReparseChain $destinationParent 'destination-parent'

    $sourceFiles = @()
    foreach ($relative in $PublicAllowlist) {
        $sourceFile = Get-RelativeFullPath $sourceFull $relative
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { throw "allowlist-file-missing-or-wrong-type:$relative" }
        Assert-NoExistingReparseChain $sourceFile "source-file:$relative"
        $sourceFiles += [pscustomobject]@{ Relative=$relative; Full=$sourceFile; Hash=(Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash }
    }

    $stage = Join-Path $destinationParent ('.review-integrated-export-' + [guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $stage -PathType Any) { throw 'staging-collision' }
    New-Item -ItemType Directory -Path $stage -Force:$false | Out-Null
    Assert-NoExistingReparseChain $stage 'staging'

    $manifestEntries = @()
    foreach ($source in $sourceFiles) {
        $destinationFile = Get-RelativeFullPath $stage $source.Relative
        $destinationFileParent = [IO.Directory]::GetParent($destinationFile)
        if (-not (Test-Path -LiteralPath $destinationFileParent -PathType Container)) {
            New-Item -ItemType Directory -Path $destinationFileParent -Force | Out-Null
        }
        Assert-NoExistingReparseChain $source.Full "source-file-before-copy:$($source.Relative)"
        Copy-Item -LiteralPath $source.Full -Destination $destinationFile -Force:$false
        Assert-NoExistingReparseChain $destinationFile "staging-file:$($source.Relative)"
        $hash = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash
        if($hash -cne $source.Hash){throw "source-changed-during-copy:$($source.Relative)"}
        $manifestEntries += [ordered]@{ path=$source.Relative; sha256=$hash }
    }

    $manifest = [ordered]@{
        package = 'review-collaboration-acp'
        status = 'clean-export'
        source_scope = 'explicit-file-allowlist'
        tested_scope = 'not-certified-by-export'
        files = @($manifestEntries)
    }
    $manifestPath = Join-Path $stage 'release-manifest.json'
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
    foreach($source in $sourceFiles){
        Assert-NoExistingReparseChain $source.Full "source-before-commit:$($source.Relative)"
        if((Get-FileHash -LiteralPath $source.Full -Algorithm SHA256).Hash -cne $source.Hash){throw "source-changed-before-commit:$($source.Relative)"}
    }
    if (Test-Path -LiteralPath $destinationFull -PathType Any) { throw 'destination-appeared-before-commit' }
    Assert-NoExistingReparseChain $destinationParent 'destination-parent-before-commit'
    [IO.Directory]::Move($stage,$destinationFull)
    $stage = $null
    [Console]::Out.WriteLine((([ordered]@{destination=$destinationFull;manifest='release-manifest.json';file_count=$manifestEntries.Count;status='exported'}) | ConvertTo-Json -Compress))
    exit 0
} catch {
    if ($null -ne $stage) {
        try {
            if (Test-NoReparseSubtree $stage) {
                Remove-OwnedStaging $stage $destinationParent
            } else {
                [Console]::Error.WriteLine('export-clean-staging-preserved-reparse:' + $stage)
            }
        } catch {
            [Console]::Error.WriteLine('export-clean-staging-preserved:' + $stage)
        }
    }
    [Console]::Error.WriteLine('export-clean-failed:' + $_.Exception.Message)
    exit 2
}
