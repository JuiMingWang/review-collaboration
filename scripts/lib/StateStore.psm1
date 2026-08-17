# StateStore.psm1
# 職責：review-state.json 的讀寫、鎖、revision、原子寫入、package 落地與 hash。
# 不做任何協定判斷（合法轉移、round/cap 由 Protocol.psm1 負責）；不呼叫 Reviewer。
#
# 設計依據：skillopt/review-collaboration-diagnostic-snapshot-2026-08-16.md 第 13 節
# 「跨 Step 決定 1」與「腳本化決定 3/4」。

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Script:SchemaDir = Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) 'schemas'

function Get-ActiveDir {
    <# .SYNOPSIS 回傳指定專案根目錄下這個 review_id 的 active 工作目錄路徑（不保證存在）。 #>
    param([Parameter(Mandatory)][string]$ProjectRoot, [Parameter(Mandatory)][string]$ReviewId)
    Join-Path (Join-Path (Join-Path $ProjectRoot '.review-collaboration') 'active') $ReviewId
}

function Get-HistoryDir {
    param([Parameter(Mandatory)][string]$ProjectRoot, [Parameter(Mandatory)][string]$ReviewId)
    Join-Path (Join-Path (Join-Path $ProjectRoot '.review-collaboration') 'history') $ReviewId
}

function Get-StatePath {
    param([Parameter(Mandatory)][string]$ProjectRoot, [Parameter(Mandatory)][string]$ReviewId)
    Join-Path (Get-ActiveDir -ProjectRoot $ProjectRoot -ReviewId $ReviewId) 'review-state.json'
}

function Get-FileSha256 {
    <# .SYNOPSIS 回傳檔案完整 SHA-256（小寫 hex，64 字元）。 #>
    param([Parameter(Mandatory)][string]$Path)
    (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-StringSha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha.ComputeHash($bytes)
        -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
    } finally { $sha.Dispose() }
}

function Set-Utf8NoBom {
    <# .SYNOPSIS 寫入 BOM-free UTF-8（codex CLI 對 schema 檔要求 BOM-free；這裡統一套用到所有 JSON/Markdown 寫入）。 #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding $false))
}

function Read-Utf8 {
    <#
    .SYNOPSIS 讀回 UTF-8 文字檔（不管有沒有 BOM），取代裸用 Get-Content -Raw。
    .DESCRIPTION Windows PowerShell 5.1 的 Get-Content 在檔案沒有 BOM 時，預設用系統代碼頁
    （不是 UTF-8）解讀內容——實測發現這會讓中文全部變亂碼，且不會丟例外，是靜默資料損毀，
    不是語法錯誤。這個專案所有寫入都經 Set-Utf8NoBom／Set-JsonAtomic（BOM-free UTF-8），
    讀回必須明確指定 -Encoding UTF8，不能依賴系統預設判斷。全專案讀取任何自己寫的 UTF-8 檔
    一律呼叫這個函式，不要再裸用 Get-Content -Raw -Path。
    #>
    param([Parameter(Mandatory)][string]$Path)
    Get-Content -Raw -Path $Path -Encoding UTF8
}

function Set-JsonAtomic {
    <#
    .SYNOPSIS 原子寫入 JSON：先寫暫存檔，再 Move-Item 覆蓋目標（同一磁碟區內 NTFS rename 為單一 metadata 操作）。
    .DESCRIPTION 中斷只可能留下未被任何人引用的 .tmp 孤兒檔，不會讓目標檔停在半寫入狀態。
    #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][object]$Object)
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $tmp = "$Path.tmp-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
    $json = $Object | ConvertTo-Json -Depth 20
    Set-Utf8NoBom -Path $tmp -Content $json
    Move-Item -Path $tmp -Destination $Path -Force
}

function Enter-ReviewLock {
    <#
    .SYNOPSIS 取得單一 review_id 的執行鎖：以獨占方式開啟一個鎖檔案並保持 handle 開啟。
    .DESCRIPTION 用 FileStream 獨占開檔（FileShare.None）取代單純的「鎖檔案存在與否」標記，
    這樣執行程序異常終止時，作業系統會在 process 結束時自動釋放檔案 handle，鎖也就跟著釋放，
    不需要額外的死亡偵測邏輯。取得失敗代表另一個執行者持有鎖，回傳 $null（呼叫端視為忙碌）。
    .OUTPUTS 成功時回傳可 Dispose 的 FileStream；忙碌時回傳 $null。
    #>
    param([Parameter(Mandatory)][string]$ProjectRoot, [Parameter(Mandatory)][string]$ReviewId, [int]$TimeoutMs = 0)
    $dir = Get-ActiveDir -ProjectRoot $ProjectRoot -ReviewId $ReviewId
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $lockPath = Join-Path $dir '.lock'
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ($true) {
        try {
            $fs = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
            return $fs
        } catch [System.IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { return $null }
            Start-Sleep -Milliseconds 50
        }
    }
}

function Exit-ReviewLock {
    param([System.IO.FileStream]$Lock)
    if ($null -ne $Lock) { $Lock.Dispose() }
}

function Get-ReviewState {
    <# .SYNOPSIS 讀取 review-state.json；不存在時回傳 $null（呼叫端視為 preparing／新案）。 #>
    param([Parameter(Mandatory)][string]$ProjectRoot, [Parameter(Mandatory)][string]$ReviewId)
    $path = Get-StatePath -ProjectRoot $ProjectRoot -ReviewId $ReviewId
    if (-not (Test-Path $path)) { return $null }
    Read-Utf8 -Path $path | ConvertFrom-Json
}

function New-ReviewState {
    <# .SYNOPSIS 建立全新 preparing 狀態物件（尚未落地，呼叫端決定何時寫入）。 #>
    param([Parameter(Mandatory)][string]$ReviewId, [int]$Cap = 5, [int]$MaterialCap = 3)
    $now = (Get-Date).ToUniversalTime().ToString('o')
    [pscustomobject]@{
        schema_version          = '1.0.0'
        review_id               = $ReviewId
        revision                = 0
        human_state             = 'preparing'
        wait_reason             = $null
        current_package_ref     = $null
        completed_round         = 0
        cap                     = $Cap
        material_cap            = $MaterialCap
        material_requests_used  = 0
        current_thread_id       = $null
        latest_ledger_ref       = $null
        current_operation       = $null
        pending_input_ref       = $null
        finalization            = $null
        created_at              = $now
        updated_at              = $now
    }
}

function Save-ReviewState {
    <#
    .SYNOPSIS 以 expected revision 原子寫入 state；不符則丟例外，呼叫端必須重新讀取。
    .DESCRIPTION 呼叫端必須先持有 Enter-ReviewLock 的鎖，這個函式本身不取鎖——
    revision 檢查防「舊資料延遲覆寫」，鎖防「同時有兩個執行者在跑」，兩者職責不同、不能互相取代。
    #>
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$ReviewId,
        [Parameter(Mandatory)][object]$NewState,
        [Parameter(Mandatory)][int]$ExpectedRevision
    )
    $path = Get-StatePath -ProjectRoot $ProjectRoot -ReviewId $ReviewId
    $current = Get-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId
    $currentRevision = if ($null -eq $current) { -1 } else { [int]$current.revision }
    if ($currentRevision -ne $ExpectedRevision) {
        throw "revision-conflict: expected $ExpectedRevision but found $currentRevision for review_id '$ReviewId'"
    }
    $NewState.revision = $ExpectedRevision + 1
    $NewState.updated_at = (Get-Date).ToUniversalTime().ToString('o')
    Set-JsonAtomic -Path $path -Object $NewState
    return $NewState
}

function Test-PackageMarkers {
    <#
    .SYNOPSIS 驗證 canonical package 的固定 section marker 是否依序、唯一出現；回傳完整 SHA-256。
    .DESCRIPTION 只驗證結構，不評斷語意——見 schemas/package-format.md。
    #>
    param([Parameter(Mandatory)][string]$Content)
    $requiredMarkers = @(
        '# REVIEW PACKAGE', '## Problem', '## Current Conclusion', '## Constraints',
        '## Key Assumptions And Verification', '## Alternatives Considered', '## Unknowns',
        '## Excluded Content', '## Checklist', '## Ceiling Breaker', '## Evidence Sources'
    )
    $lines = $Content -split "`r?`n"
    $lastIndex = -1
    $seen = @{}
    foreach ($marker in $requiredMarkers) {
        $idx = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i].TrimEnd() -eq $marker) { $idx = $i; break }
        }
        if ($idx -lt 0) { throw "package-marker-missing: '$marker'" }
        if ($seen.ContainsKey($marker)) { throw "package-marker-duplicate: '$marker'" }
        $seen[$marker] = $true
        # @(...) 強制陣列 context：Where-Object 只命中 1 筆時會回傳裸字串而非陣列，
        # Set-StrictMode -Version Latest 下對裸字串取 .Count 會直接丟例外（實測抓到），不能省略 @()。
        $dupCount = (@($lines | Where-Object { $_.TrimEnd() -eq $marker })).Count
        if ($dupCount -gt 1) { throw "package-marker-duplicate: '$marker'" }
        if ($idx -le $lastIndex) { throw "package-marker-out-of-order: '$marker'" }
        $lastIndex = $idx
    }
    Get-StringSha256 -Text $Content
}

function Confirm-Package {
    <#
    .SYNOPSIS 安全落地 canonical package：暫存寫入 → 依完整 hash atomic rename → 讀回驗 hash →
              以 expected revision 原子更新 state（進入 confirmed-recoverable 或沿用目前 human_state 的下一步)。
    .DESCRIPTION 對應單一入口的 confirm-package 命令；只在此函式內建立/更新 active 目錄與 state。
    #>
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$ReviewId,
        [Parameter(Mandatory)][string]$PackageContent,
        [Parameter(Mandatory)][int]$Cap,
        [int]$MaterialCap = 3
    )
    $hash = Test-PackageMarkers -Content $PackageContent   # 驗證失敗直接丟例外，不落地任何檔案

    $activeDir = Get-ActiveDir -ProjectRoot $ProjectRoot -ReviewId $ReviewId
    $packagesDir = Join-Path $activeDir 'packages'
    New-Item -ItemType Directory -Path $packagesDir -Force | Out-Null
    $finalPath = Join-Path $packagesDir "$hash.package.md"
    $tmpPath = "$finalPath.tmp-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
    Set-Utf8NoBom -Path $tmpPath -Content $PackageContent
    Move-Item -Path $tmpPath -Destination $finalPath -Force

    # 讀回驗 hash：確保 rename 後檔案內容跟寫入前一致，不是假設「rename 成功＝內容正確」。
    $readBackHash = Get-FileSha256 -Path $finalPath
    if ($readBackHash -ne $hash) {
        throw "package-hash-mismatch-after-write: expected $hash but read back $readBackHash"
    }

    $lockHandle = Enter-ReviewLock -ProjectRoot $ProjectRoot -ReviewId $ReviewId -TimeoutMs 5000
    if ($null -eq $lockHandle) { throw "review-busy: another operation holds the lock for '$ReviewId'" }
    try {
        $current = Get-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId
        if ($null -eq $current) {
            $newState = New-ReviewState -ReviewId $ReviewId -Cap $Cap -MaterialCap $MaterialCap
            $expectedRevision = -1   # Save-ReviewState 對「檔案還不存在」的慣例是 -1，不是 0（0 是存檔後的第一個 revision）。
        } else {
            $newState = $current | Select-Object *
            $expectedRevision = [int]$current.revision
        }
        $newState.current_package_ref = [pscustomobject]@{ package_hash = $hash; path = $finalPath }
        $newState.human_state = 'confirmed-recoverable'
        $newState.wait_reason = $null
        Save-ReviewState -ProjectRoot $ProjectRoot -ReviewId $ReviewId -NewState $newState -ExpectedRevision $expectedRevision
    } finally {
        Exit-ReviewLock -Lock $lockHandle
    }
}

Export-ModuleMember -Function `
    Get-ActiveDir, Get-HistoryDir, Get-StatePath, Get-FileSha256, Get-StringSha256, Set-Utf8NoBom, Read-Utf8, `
    Set-JsonAtomic, Enter-ReviewLock, Exit-ReviewLock, Get-ReviewState, New-ReviewState, Save-ReviewState, `
    Test-PackageMarkers, Confirm-Package
