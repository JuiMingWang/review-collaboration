# StateStore.Tests.ps1
# 測試檔案 I/O、鎖、原子寫入、revision 檢查、package 結構驗證。不呼叫 Reviewer，不花 Codex 額度。
# 每個 It 用獨立的暫存目錄（$env:TEMP 底下帶隨機字尾），彼此不共用狀態，可平行重跑不互相汙染。

$modulePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\lib\StateStore.psm1'
Import-Module $modulePath -Force

function New-TempRoot {
    $p = Join-Path $env:TEMP ("rc-test-" + [Guid]::NewGuid().ToString('N').Substring(0, 10))
    New-Item -ItemType Directory -Path $p -Force | Out-Null
    return $p
}

function New-ValidPackageContent {
    @'
# REVIEW PACKAGE
## Problem
p
## Current Conclusion
c
## Constraints
none
## Key Assumptions And Verification
- a（可查證且已查證）
## Alternatives Considered
none
## Unknowns
none
## Excluded Content
none
## Checklist
- [x] done
## Ceiling Breaker
none
## Evidence Sources
none
'@
}

Describe "Get-StringSha256 / Get-FileSha256" {
    It "produces a 64-char lowercase hex digest" {
        $h = Get-StringSha256 -Text "hello"
        $h.Length | Should Be 64
        $h | Should Be $h.ToLowerInvariant()
    }
    It "matches the independently-known SHA-256 of the empty string" {
        # 這是 SHA-256("") 的公開已知值，不是我自己算的，用來確認函式沒有算錯。
        Get-StringSha256 -Text "" | Should Be "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
    It "Get-FileSha256 agrees with Get-StringSha256 for the same content" {
        $root = New-TempRoot
        try {
            $p = Join-Path $root "f.txt"
            Set-Utf8NoBom -Path $p -Content "abc"
            (Get-FileSha256 -Path $p) | Should Be (Get-StringSha256 -Text "abc")
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe "Set-Utf8NoBom / Read-Utf8 round-trip" {
    It "writes without a BOM" {
        $root = New-TempRoot
        try {
            $p = Join-Path $root "f.txt"
            Set-Utf8NoBom -Path $p -Content "test"
            $bytes = [System.IO.File]::ReadAllBytes($p)
            ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) | Should Be $false
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It "round-trips Traditional Chinese content without corruption (regression: 過去 Get-Content -Raw 沒指定 -Encoding 會靜默亂碼)" {
        $root = New-TempRoot
        try {
            $p = Join-Path $root "f.txt"
            $original = "查證標籤：可查證但未查證，中文內容不能變亂碼"
            Set-Utf8NoBom -Path $p -Content $original
            (Read-Utf8 -Path $p) | Should Be $original
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe "Set-JsonAtomic" {
    It "leaves no .tmp-* orphan file behind after a successful write" {
        $root = New-TempRoot
        try {
            $p = Join-Path $root "f.json"
            Set-JsonAtomic -Path $p -Object ([pscustomobject]@{ a = 1 })
            (Get-ChildItem -Path $root -Filter "*.tmp-*").Count | Should Be 0
            (Test-Path $p) | Should Be $true
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It "overwrites an existing file completely (no leftover trailing content from a longer previous write)" {
        $root = New-TempRoot
        try {
            $p = Join-Path $root "f.json"
            Set-JsonAtomic -Path $p -Object ([pscustomobject]@{ longField = "x" * 200 })
            Set-JsonAtomic -Path $p -Object ([pscustomobject]@{ a = 1 })
            $readBack = Read-Utf8 -Path $p | ConvertFrom-Json
            $readBack.a | Should Be 1
            ($readBack.PSObject.Properties.Name -contains 'longField') | Should Be $false
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe "Enter-ReviewLock / Exit-ReviewLock" {
    It "a second Enter-ReviewLock call blocks while the first lock is still held (mutual exclusion)" {
        $root = New-TempRoot
        try {
            $lock1 = Enter-ReviewLock -ProjectRoot $root -ReviewId 'r1' -TimeoutMs 0
            $lock1 | Should Not Be $null
            $lock2 = Enter-ReviewLock -ProjectRoot $root -ReviewId 'r1' -TimeoutMs 300
            $lock2 | Should Be $null
            Exit-ReviewLock -Lock $lock1
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It "releases the lock on Exit-ReviewLock so a subsequent Enter-ReviewLock succeeds" {
        $root = New-TempRoot
        try {
            $lock1 = Enter-ReviewLock -ProjectRoot $root -ReviewId 'r1' -TimeoutMs 0
            Exit-ReviewLock -Lock $lock1
            $lock2 = Enter-ReviewLock -ProjectRoot $root -ReviewId 'r1' -TimeoutMs 0
            $lock2 | Should Not Be $null
            Exit-ReviewLock -Lock $lock2
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It "different review_id values do not contend for the same lock" {
        $root = New-TempRoot
        try {
            $lockA = Enter-ReviewLock -ProjectRoot $root -ReviewId 'a' -TimeoutMs 0
            $lockB = Enter-ReviewLock -ProjectRoot $root -ReviewId 'b' -TimeoutMs 0
            $lockA | Should Not Be $null
            $lockB | Should Not Be $null
            Exit-ReviewLock -Lock $lockA
            Exit-ReviewLock -Lock $lockB
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe "Save-ReviewState revision 檢查" {
    It "throws revision-conflict when ExpectedRevision doesn't match what's on disk" {
        $root = New-TempRoot
        try {
            $s = New-ReviewState -ReviewId 'r1' -Cap 5
            Save-ReviewState -ProjectRoot $root -ReviewId 'r1' -NewState $s -ExpectedRevision -1 | Out-Null
            # 現在磁碟上 revision=0；用錯誤的 expected (-1 而非 0) 再存一次應該失敗，模擬「兩個執行者用了舊資料」。
            { Save-ReviewState -ProjectRoot $root -ReviewId 'r1' -NewState $s -ExpectedRevision -1 } | Should Throw 'revision-conflict'
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It "succeeds and increments revision when ExpectedRevision matches" {
        $root = New-TempRoot
        try {
            $s = New-ReviewState -ReviewId 'r1' -Cap 5
            Save-ReviewState -ProjectRoot $root -ReviewId 'r1' -NewState $s -ExpectedRevision -1 | Out-Null
            $current = Get-ReviewState -ProjectRoot $root -ReviewId 'r1'
            $current.revision | Should Be 0
            Save-ReviewState -ProjectRoot $root -ReviewId 'r1' -NewState $current -ExpectedRevision 0 | Out-Null
            (Get-ReviewState -ProjectRoot $root -ReviewId 'r1').revision | Should Be 1
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe "Test-PackageMarkers" {
    It "accepts a fully-formed package and returns its SHA-256" {
        $content = New-ValidPackageContent
        $hash = Test-PackageMarkers -Content $content
        $hash | Should Be (Get-StringSha256 -Text $content)
    }
    It "rejects a package missing a required marker" {
        $content = (New-ValidPackageContent) -replace [regex]::Escape("## Unknowns`n"), ""
        { Test-PackageMarkers -Content $content } | Should Throw 'package-marker-missing'
    }
    It "rejects a duplicated marker" {
        $content = (New-ValidPackageContent) + "`n## Problem`nduplicate"
        { Test-PackageMarkers -Content $content } | Should Throw 'package-marker-duplicate'
    }
    It "rejects markers that appear out of the required order" {
        # 把 '## Constraints' 整段搬到檔案最前面（連 '# REVIEW PACKAGE' 都排在它後面），
        # 製造一個確定會違反必要順序的排列——Agy 審查抓到先前這裡的註解寫成「搬到 Problem 之前」
        # 但實際位移量算到了整份文件開頭，且留了一個沒用到的 $problemIdx，修正成如實描述。
        $lines = (New-ValidPackageContent) -split "`r?`n"
        $constraintsIdx = [Array]::IndexOf($lines, '## Constraints')
        $reordered = @($lines[$constraintsIdx]) + $lines[0..($constraintsIdx - 1)] + $lines[($constraintsIdx + 1)..($lines.Length - 1)]
        { Test-PackageMarkers -Content ($reordered -join "`n") } | Should Throw 'package-marker-out-of-order'
    }
}

Describe "Confirm-Package" {
    It "lands the package file and sets human_state=confirmed-recoverable" {
        $root = New-TempRoot
        try {
            $content = New-ValidPackageContent
            Confirm-Package -ProjectRoot $root -ReviewId 'r1' -PackageContent $content -Cap 5 | Out-Null
            $state = Get-ReviewState -ProjectRoot $root -ReviewId 'r1'
            $state.human_state | Should Be 'confirmed-recoverable'
            $state.current_package_ref.package_hash | Should Be (Get-StringSha256 -Text $content)
            (Test-Path $state.current_package_ref.path) | Should Be $true
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
    It "writes nothing when marker validation fails up front (Agy 審查指出：這只覆蓋 Test-PackageMarkers 這一關失敗的情況，不覆蓋鎖取得後、寫檔中途失敗的情境——目前沒有辦法在不改程式碼的前提下注入那種失敗，如實標註範圍)" {
        $root = New-TempRoot
        try {
            $badContent = "# not a real package"
            { Confirm-Package -ProjectRoot $root -ReviewId 'r1' -PackageContent $badContent -Cap 5 } | Should Throw 'package-marker-missing'
            (Test-Path (Join-Path $root '.review-collaboration')) | Should Be $false
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
