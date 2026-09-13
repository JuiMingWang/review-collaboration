# Windows host entry. All business data stays in the UTF-8 request file.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$RequestFile,
    [string]$OutputDirectory,
    [int]$TimeoutMs=615000
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$utf8=New-Object Text.UTF8Encoding($false)
$script:resultFile=$null
$packageRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
function Get-Field($Object,[string]$Name) {
    if($null -eq $Object){return $null}
    $prop=$Object.PSObject.Properties[$Name]
    if($null -eq $prop){return $null}
    return $prop.Value
}
function Has-Field($Object,[string]$Name) {
    return ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name])
}
function Same-Scalar($Actual,$Expected) {
    if($null -eq $Expected){return ($null -eq $Actual)}
    if($Expected -is [bool]){return ($Actual -is [bool] -and $Actual -eq $Expected)}
    if($Expected -is [string]){return ($Actual -is [string] -and $Actual -ceq $Expected)}
    return (($Actual -is [int] -or $Actual -is [long]) -and $Actual -eq $Expected)
}
function Assert-LocalPath([string]$Path) {
    if($Path -notmatch '^[a-zA-Z]:[\\/]' -or $Path.Substring(2).Contains(':')){throw 'unsafe-path'}
    $parts=$Path.Substring(3) -split '[\\/]'
    foreach($part in $parts){if($part -in @('.','..') -or $part -match '[. ]$'){throw 'unsafe-path'}}
    $full=[IO.Path]::GetFullPath($Path)
    $walk=$full
    while($walk){
        if(Test-Path -LiteralPath $walk){
            $item=Get-Item -LiteralPath $walk -Force
            if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'unsafe-path'}
        }
        $walk=[IO.Path]::GetDirectoryName($walk)
    }
    return $full
}
function Hash-File([string]$Path) {
    $sha=[Security.Cryptography.SHA256]::Create()
    try{return -join ($sha.ComputeHash([IO.File]::ReadAllBytes($Path))|ForEach-Object {$_.ToString('x2')})}
    finally{$sha.Dispose()}
}
function Write-NewJson([string]$Path,$Value) {
    $bytes=$utf8.GetBytes(($Value|ConvertTo-Json -Depth 24 -Compress))
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Get-RunDeadline($Envelope) {
    $runId=Get-Field (Get-Field $Envelope 'args') 'run_id'
    if($runId -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'){throw 'invalid-run-id'}
    $record=Assert-LocalPath (Get-Field $Envelope 'record_root')
    $topics=Assert-LocalPath (Join-Path $record 'topics')
    $matches=@()
    foreach($topic in @(Get-ChildItem -LiteralPath $topics -Directory -Force)){
        $file=Assert-LocalPath (Join-Path $topic.FullName ('runs\'+$runId+'\run.json'))
        if(Test-Path -LiteralPath $file -PathType Leaf){
            $run=[IO.File]::ReadAllText($file,$utf8)|ConvertFrom-Json
            if((Get-Field $run 'run_id') -cne $runId -or (Get-Field $run 'topic_id') -cne $topic.Name){throw 'record-inconsistent'}
            $times=Get-Field $run 'timeouts';$outer=Get-Field $times 'outer_hard_timeout_ms'
            $prompt=Get-Field $times 'prompt_deadline_ms';$grace=Get-Field $times 'cancel_grace_ms'
            foreach($value in @($outer,$prompt,$grace)){if(-not ($value -is [int] -or $value -is [long])){throw 'invalid-deadline'}}
            if($outer -lt 100 -or $outer -gt 3615000 -or $prompt -lt 100 -or $grace -lt 1 -or $outer -lt ($prompt+$grace)){throw 'invalid-deadline'}
            $matches+=@{timeout=$outer;run_sha256=(Hash-File $file)}
        }
    }
    if($matches.Count -ne 1){throw 'run-not-found-or-ambiguous'}
    return $matches[0]
}
function Write-Result($Result) {
    $json=$Result|ConvertTo-Json -Depth 24 -Compress
    if($null -ne $script:resultFile){[IO.File]::WriteAllText($script:resultFile,$json,$utf8)}
    [Console]::Out.WriteLine($json)
}
function Read-Transport([string]$Directory,[string]$TransportRequest,[string]$InputFile,[string]$InputHash,[int]$WrapperExit) {
    $receiptPath=Join-Path $Directory 'receipt.json'
    $receipt=$null
    try{$receipt=[IO.File]::ReadAllText($receiptPath,$utf8)|ConvertFrom-Json}catch{}
    $problems=New-Object 'System.Collections.Generic.List[string]'
    if($null -eq $receipt){$problems.Add('transport-receipt-missing')}
    else{
        $expected=@{schema_version=1;transport_status='success';transport_exit_code=0;native_exit_code=0;process_started=$true;timed_out=$false;stdout_truncated=$false;stderr_truncated=$false;request_file=$TransportRequest;input_file=$InputFile;input_sha256=$InputHash}
        foreach($key in $expected.Keys){
            $actual=Get-Field $receipt $key
            if(-not (Has-Field $receipt $key) -or -not (Same-Scalar $actual $expected[$key])){$problems.Add("receipt-$key")}
        }
        $cleanup=Get-Field $receipt 'cleanup'
        $cleanExpected=@{job_created=$true;job_attached=$true;process_exited=$true;stdin_completed=$true;stdout_completed=$true;stderr_completed=$true;stream_wait_timed_out=$false;cleanup_complete=$true;owned_processes_remaining=0}
        foreach($key in $cleanExpected.Keys){if(-not (Has-Field $cleanup $key) -or -not (Same-Scalar (Get-Field $cleanup $key) $cleanExpected[$key])){$problems.Add("cleanup-$key")}}
        if(-not (Has-Field $cleanup 'tree_terminated')){$problems.Add('cleanup-tree_terminated')}
        $capture=Get-Field $receipt 'capture'
        foreach($key in @('launch_error','stdin_error','stdout_error','stderr_error')){
            if(-not (Has-Field $capture $key) -or $null -ne (Get-Field $capture $key)){$problems.Add("capture-$key")}
        }
    }
    if($WrapperExit -ne 0){$problems.Add("wrapper-exit-$WrapperExit")}
    $helper=$null
    try{
        $text=[IO.File]::ReadAllText((Join-Path $Directory 'stdout.bin'),$utf8)
        $lines=@($text -split "\r?\n"|Where-Object {$_.Trim()})
        if($lines.Count -eq 1){$helper=$lines[0]|ConvertFrom-Json}
    }catch{}
    if($null -eq $helper -or -not (Same-Scalar (Get-Field $helper 'ok') $true)){$problems.Add('helper-did-not-report-success')}
    return @{receipt=$receipt;helper=$helper;problems=@($problems.ToArray())}
}
try{
    $requestFull=Assert-LocalPath ([IO.Path]::GetFullPath($RequestFile))
    if(-not (Test-Path -LiteralPath $requestFull -PathType Leaf)){throw 'request-file-missing'}
    if($TimeoutMs -lt 100 -or $TimeoutMs -gt 3615000){throw 'invalid-deadline'}
    if(-not $OutputDirectory){
        $private=Join-Path $packageRoot '_private'
        $cursor=$packageRoot
        while($cursor){
            if(Test-Path -LiteralPath (Join-Path $cursor '.git')){
                $tracked=@(& git -C $cursor ls-files -- $private 2>$null)
                if($LASTEXITCODE -ne 0){throw 'private-root-git-unknown'}
                if($tracked.Count -gt 0){throw 'private-root-git-tracked'}
                break
            }
            $cursor=[IO.Path]::GetDirectoryName($cursor)
        }
        [void](Assert-LocalPath $private)
        [void][IO.Directory]::CreateDirectory($private)
        $ignore=Join-Path $private '.gitignore'
        if(-not (Test-Path -LiteralPath $ignore)){[IO.File]::WriteAllText($ignore,"*"+[Environment]::NewLine,$utf8)}
        [void](Assert-LocalPath $ignore)
        if([IO.File]::ReadAllText($ignore,$utf8).Trim() -cne '*'){throw 'private-ignore-unverified'}
        $operations=Join-Path $private 'operations'
        [void][IO.Directory]::CreateDirectory($operations)
        $OutputDirectory=Join-Path $operations ([Guid]::NewGuid().ToString())
    }
    $outputFull=Assert-LocalPath ([IO.Path]::GetFullPath($OutputDirectory))
    if(Test-Path -LiteralPath $outputFull){throw 'output-directory-exists'}
    $transportRequest=$outputFull+'.transport-request.json'
    $invocationFile=$outputFull+'.invocation.json'
    if(Test-Path -LiteralPath $transportRequest){throw 'transport-request-exists'}
    if(Test-Path -LiteralPath $invocationFile){throw 'invocation-file-exists'}
    $parent=[IO.Path]::GetDirectoryName($outputFull)
    if(-not (Test-Path -LiteralPath $parent -PathType Container)){throw 'output-parent-missing'}
    $node=Get-Command node.exe -ErrorAction Stop
    $nodeFull=[IO.Path]::GetFullPath($node.Source)
    $helper=Join-Path $PSScriptRoot 'review-mail.mjs'
    $invoke=Join-Path $PSScriptRoot 'invoke-process.ps1'
    $requestSha=Hash-File $requestFull
    $invocation=[ordered]@{schema_version=1;invocation_id=[Guid]::NewGuid().ToString();envelope_sha256=$requestSha;request_file=$requestFull;transport_request=$transportRequest;receipt_file=(Join-Path $outputFull 'receipt.json');invocation_file=$invocationFile;output_directory=$outputFull}
    $envelope=[IO.File]::ReadAllText($requestFull,$utf8)|ConvertFrom-Json
    $invocation.timeout_source=if($PSBoundParameters.ContainsKey('TimeoutMs')){'explicit-wrapper'}else{'wrapper-default'}
    if((Get-Field $envelope 'action') -eq 'exchange' -and -not $PSBoundParameters.ContainsKey('TimeoutMs')){
        $deadline=Get-RunDeadline $envelope
        $TimeoutMs=[int]$deadline.timeout
        $invocation.timeout_source='run-snapshot'
        $invocation.run_sha256=$deadline.run_sha256
    }
    $invocation.effective_timeout_ms=$TimeoutMs
    $transportPayload=[ordered]@{version=1;executable=$nodeFull;arguments=@($helper,'--invocation',$invocationFile);working_directory=$packageRoot;stdin_file=$requestFull;timeout_ms=$TimeoutMs}
    # CreateNew on the common transport filename gives one caller ownership.
    Write-NewJson $transportRequest $transportPayload
    Write-NewJson $invocationFile $invocation
    & $invoke -RequestFile $transportRequest -OutputDirectory $outputFull|Out-Null
    $outerExit=$LASTEXITCODE
    if(Test-Path -LiteralPath $outputFull -PathType Container){$script:resultFile=Join-Path $outputFull 'mail-result.json'}
    $outer=Read-Transport $outputFull $transportRequest $requestFull $requestSha $outerExit
    $final=$null
    $envelope=$null
    try{$envelope=[IO.File]::ReadAllText($requestFull,$utf8)|ConvertFrom-Json}catch{}
    $action=Get-Field $envelope 'action'
    # Finalization starts only after the original Job receipt is on disk.
    if($null -ne $outer.receipt -and $action -in @('exchange','probe')){
        $finalRequest=Join-Path $outputFull 'finalize-request.json'
        $finalDirectory=Join-Path $outputFull 'finalize'
        $payload=[ordered]@{version=1;executable=$nodeFull;arguments=@($helper,'--invocation',$invocationFile,'--finalize');working_directory=$packageRoot;stdin_file=$requestFull;timeout_ms=30000}
        Write-NewJson $finalRequest $payload
        & $invoke -RequestFile $finalRequest -OutputDirectory $finalDirectory|Out-Null
        $finalExit=$LASTEXITCODE
        $final=Read-Transport $finalDirectory $finalRequest $requestFull $requestSha $finalExit
    }
    $problems=@($outer.problems)
    $chosen=$outer.helper
    if($null -ne $final){$problems+=@($final.problems);if($null -ne $final.helper){$chosen=$final.helper}}
    $ok=$problems.Count -eq 0
    $code='ok'
    if(-not $ok){
        $candidateCode=Get-Field $chosen 'code'
        if($null -ne $outer.helper -and (Get-Field $outer.helper 'ok') -ne $true){$code=Get-Field $outer.helper 'code'}
        elseif($candidateCode -and $candidateCode -ne 'ok'){$code=$candidateCode}
        else{$code=$problems[0]}
    }
    Write-Result @{schema_version=1;ok=$ok;code=$code;data=(Get-Field $chosen 'data');evidence_refs=@((Get-Field $chosen 'evidence_refs'));helper_result=$chosen;initial_helper_result=$outer.helper;problems=$problems;native_exit_code=(Get-Field $outer.receipt 'native_exit_code');transport_exit_code=(Get-Field $outer.receipt 'transport_exit_code');transport_status=(Get-Field $outer.receipt 'transport_status');timed_out=(Get-Field $outer.receipt 'timed_out');cleanup=(Get-Field $outer.receipt 'cleanup');capture=(Get-Field $outer.receipt 'capture');output_directory=$outputFull;transport_request=$transportRequest;request_sha256=$requestSha}
    if($ok){exit 0}
    $native=Get-Field $outer.receipt 'native_exit_code'
    if($null -ne $native -and [int]$native -ne 0){exit ([int]$native)}
    exit 2
}catch{
    $message=$_.Exception.Message
    $known=@('unsafe-path','request-file-missing','output-directory-exists','transport-request-exists','invocation-file-exists','output-parent-missing','private-root-git-unknown','private-root-git-tracked','invalid-deadline','invalid-run-id','record-inconsistent','run-not-found-or-ambiguous')
    $detail=if($message -in $known){$message}else{'wrapper-operation-failed'}
    Write-Result @{schema_version=1;ok=$false;code='wrapper-error';detail=$detail;data=@{};evidence_refs=@()}
    exit 2
}
