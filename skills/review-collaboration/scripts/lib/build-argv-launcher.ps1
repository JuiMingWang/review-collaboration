# Compile only this package's fixed launcher source, never caller-supplied code.
# A failure names its cause as the last stderr line: request-invalid,
# compiler-unavailable, compile-failed:<first error number> or build-failed:<exception type>.
# Started from a PowerShell 7 session, Windows PowerShell inherits a module path
# that finds 7.x built-in modules first and then lacks commands it needs.
if($PSVersionTable.PSEdition -ne 'Core'){$env:PSModulePath="$PSHOME\Modules;$env:PSModulePath"}
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$stage=$null
try {
    [Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
    [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
    $stage='request-invalid'
    $request=[Console]::In.ReadToEnd()|ConvertFrom-Json
    $output=[string]$request.output_file
    if(-not $output){throw 'output_file missing'}
    $stage='compiler-unavailable'
    $provider=New-Object Microsoft.CSharp.CSharpCodeProvider
    $parameters=New-Object System.CodeDom.Compiler.CompilerParameters
    $parameters.GenerateExecutable=$true
    $parameters.OutputAssembly=$output
    $parameters.CompilerOptions='/optimize+'
    [void]$parameters.ReferencedAssemblies.Add('System.dll')
    [void]$parameters.ReferencedAssemblies.Add('System.Web.Extensions.dll')
    try{$result=$provider.CompileAssemblyFromFile($parameters,(Join-Path $PSScriptRoot 'ArgvLauncher.cs'))}finally{$provider.Dispose()}
    $stage=$null
    $errors=@($result.Errors|Where-Object {-not $_.IsWarning})
    if($errors.Count -gt 0){[Console]::Error.WriteLine('compile-failed:'+$errors[0].ErrorNumber);exit 1}
    [Console]::Out.WriteLine('{"ok":true}')
}catch{
    $reason=if($stage){$stage}else{'build-failed'}
    [Console]::Error.WriteLine($reason+':'+$_.Exception.GetType().Name)
    exit 1
}
