# Starts one reviewer process tree at Low integrity (see lib/LowIntegrityLauncher.cs).
# Called only by scripts/lib/acp-client.mjs for read-access routes. Standard
# handles, cwd and environment pass through; stdout stays reserved for the
# child's ACP stream. Exit code is the child's; 125 means the launch failed.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ArgvBase64)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
    $source = Join-Path $PSScriptRoot 'lib\LowIntegrityLauncher.cs'
    if ($null -eq ('ReviewCollaboration.Launch.LowIntegrityLauncher' -as [type])) {
        Add-Type -TypeDefinition ([IO.File]::ReadAllText($source, [Text.Encoding]::UTF8)) -Language CSharp -ReferencedAssemblies @('System.dll') -ErrorAction Stop | Out-Null
    }
    $argv = [string[]](ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgvBase64))))
    if ($argv.Count -lt 1 -or -not [IO.Path]::IsPathRooted($argv[0])) { throw 'launch-argv-invalid' }
    $rest = if ($argv.Count -gt 1) { [string[]]$argv[1..($argv.Count - 1)] } else { [string[]]@() }
    exit ([ReviewCollaboration.Launch.LowIntegrityLauncher]::Run($argv[0], $rest))
}
catch {
    [Console]::Error.WriteLine('low-integrity-launch-failed: ' + $_.Exception.Message)
    exit 125
}
