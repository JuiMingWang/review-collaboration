# codex-adapter.ps1
# 正式 Reviewer adapter：接住 ReviewerAdapter.psm1 的固定介面，執行真實 codex exec 呼叫。
# 介面參數：-PromptFile <path> -OutFile <path> -EventsFile <path> [-ThreadId <id>] [-SchemaFile <path>] [-Model <name>] [-ReasoningEffort <level>]
#
# 設計依據：planB-task-spec.md 2.1 節與 formal SKILL.md Windows/PowerShell 實測慣例。

param(
    [Parameter(Mandatory = $true)][string]$PromptFile,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [Parameter(Mandatory = $true)][string]$EventsFile,
    [string]$ThreadId,
    [string]$SchemaFile,
    [string]$Model = 'gpt-5.6-sol',
    [string]$ReasoningEffort = 'high'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 1. 主控台編碼設定：避免管線傳遞中文內容時被系統預設代碼頁（Big5/cp950）損壞
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# 2. 解析 Schema 檔案路徑（預設指向專案 schemas/reviewer-result.schema.json）
$resolvedSchema = $null
if ($SchemaFile -and (Test-Path $SchemaFile)) {
    $resolvedSchema = (Resolve-Path $SchemaFile).Path
} else {
    $projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $defaultSchemaPath = Join-Path $projectRoot 'schemas\reviewer-result.schema.json'
    if (Test-Path $defaultSchemaPath) {
        $resolvedSchema = (Resolve-Path $defaultSchemaPath).Path
    } else {
        throw "schema-file-not-found: '$defaultSchemaPath'"
    }
}

# 確保 PromptFile 存在
if (-not (Test-Path $PromptFile)) {
    throw "prompt-file-not-found: '$PromptFile'"
}

# 確保輸出目錄存在
$outDir = Split-Path -Parent $OutFile
if ($outDir -and -not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
$eventsDir = Split-Path -Parent $EventsFile
if ($eventsDir -and -not (Test-Path $eventsDir)) {
    New-Item -ItemType Directory -Path $eventsDir -Force | Out-Null
}

# 3. 呼叫 codex exec
# 規則遵守：
# - 固定旗標：--ignore-user-config -m <model> -c model_reasoning_effort=<effort> --sandbox read-only --skip-git-repo-check
# - 絕不重導向 stderr（PowerShell 5.1 會把正常 stderr 包成 NativeCommandError 誤判失敗）
# - events 輸出導向 $EventsFile，結構化 JSON 輸出由 codex -o 寫入 $OutFile
# - 有 $ThreadId 帶 resume，首輪不帶 resume

if ($ThreadId) {
    Get-Content -Raw -Path $PromptFile -Encoding UTF8 | codex exec --json --output-schema "$resolvedSchema" --ignore-user-config -m $Model -c "model_reasoning_effort=$ReasoningEffort" --sandbox read-only --skip-git-repo-check -o "$OutFile" resume $ThreadId - > "$EventsFile"
} else {
    Get-Content -Raw -Path $PromptFile -Encoding UTF8 | codex exec --json --output-schema "$resolvedSchema" --ignore-user-config -m $Model -c "model_reasoning_effort=$ReasoningEffort" --sandbox read-only --skip-git-repo-check -o "$OutFile" - > "$EventsFile"
}

exit [int]$LASTEXITCODE
