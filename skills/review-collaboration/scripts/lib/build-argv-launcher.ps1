# Compile only this package's fixed launcher source, never caller-supplied code.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
try {
    $request=[Console]::In.ReadToEnd()|ConvertFrom-Json
    $provider=New-Object Microsoft.CSharp.CSharpCodeProvider
    $parameters=New-Object System.CodeDom.Compiler.CompilerParameters
    $parameters.GenerateExecutable=$true
    $parameters.OutputAssembly=[string]$request.output_file
    $parameters.CompilerOptions='/optimize+'
    [void]$parameters.ReferencedAssemblies.Add('System.dll')
    [void]$parameters.ReferencedAssemblies.Add('System.Web.Extensions.dll')
    try{$result=$provider.CompileAssemblyFromFile($parameters,(Join-Path $PSScriptRoot 'ArgvLauncher.cs'))}finally{$provider.Dispose()}
    if($result.Errors.HasErrors){throw 'compile-failed'}
    [Console]::Out.WriteLine('{"ok":true}')
}catch{[Console]::Error.WriteLine('launcher-build-failed');exit 1}
