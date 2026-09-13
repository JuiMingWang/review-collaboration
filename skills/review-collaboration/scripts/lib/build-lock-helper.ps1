# Compiles only the package-owned C# source. Caller supplies JSON paths on stdin.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $source = Join-Path $PSScriptRoot 'LockTransaction.cs'
    $provider = New-Object Microsoft.CSharp.CSharpCodeProvider
    $parameters = New-Object System.CodeDom.Compiler.CompilerParameters
    $parameters.GenerateExecutable = $true
    $parameters.GenerateInMemory = $false
    $parameters.OutputAssembly = [string]$request.output_file
    $parameters.CompilerOptions = '/optimize+'
    [void]$parameters.ReferencedAssemblies.Add('System.dll')
    [void]$parameters.ReferencedAssemblies.Add('System.Web.Extensions.dll')
    try { $result = $provider.CompileAssemblyFromFile($parameters, $source) } finally { $provider.Dispose() }
    if ($result.Errors.HasErrors) { throw 'lock-helper-compilation-failed' }
    [Console]::Out.WriteLine('{"ok":true}')
} catch { [Console]::Error.WriteLine('lock-helper-build-failed'); exit 1 }
