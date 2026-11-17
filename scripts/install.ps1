<#
.SYNOPSIS
  Deepseek bot / Dsh bot 一键安装（Windows PowerShell）。

.DESCRIPTION
  从 GitHub Releases 下载最新发布包，解压到安装目录，做基本自检，然后打印下一步。
  装好后有二种用法：
    1) 作为 DSH 插件：DSH → 插件 → 添加插件 → 选 <安装目录>\plugin
    2) 独立运行：node <安装目录>\service\bin\dsteam.mjs --port 8790

.EXAMPLE
  iwr https://raw.githubusercontent.com/xyamtf/deepseek-bot-team/main/scripts/install.ps1 -UseBasicParsing | iex

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -Dir D:\apps\deepseek-bot -Run
#>
[CmdletBinding()]
param(
  [string]$Dir = (Join-Path $env:USERPROFILE '.deepseek-bot-team'),
  [string]$Version = 'latest',
  [switch]$Force,
  [switch]$Standalone,
  [int]$Port = 8790
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$Owner = 'xyamtf'
$Repo = 'deepseek-bot-team'

function Write-Step($text) { Write-Host "`n• $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  ✓ $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "  ! $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "`n✗ $text" -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '  Deepseek bot —— 一键安装' -ForegroundColor Cyan
Write-Host '  多 Bot 团队，装进 DeepSeek Harness' -ForegroundColor DarkGray

# 1. Node ----------------------------------------------------------------------
Write-Step '检查 Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail '没有找到 node。请先安装 Node.js 20.11 或更高版本：https://nodejs.org/' }
$nodeVersion = (& node --version).TrimStart('v')
$parts = $nodeVersion.Split('.')
$major = [int]$parts[0]; $minor = [int]$parts[1]
if ($major -lt 20 -or ($major -eq 20 -and $minor -lt 11)) {
  Fail "Node.js 版本过低：$nodeVersion（需要 ≥ 20.11）"
}
Write-Ok "node $nodeVersion"

# 2. Release -------------------------------------------------------------------
Write-Step "解析发布包（$Version）"
$headers = @{ 'User-Agent' = 'deepseek-bot-installer' }
$apiBase = "https://api.github.com/repos/$Owner/$Repo/releases"
$releaseUrl = if ($Version -eq 'latest') { "$apiBase/latest" } else { "$apiBase/tags/$Version" }
try {
  $release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers -TimeoutSec 30
} catch {
  Fail "读取发布信息失败：$($_.Exception.Message)"
}
$asset = $release.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1
if (-not $asset) { Fail "发布 $($release.tag_name) 里没有 zip 附件" }
Write-Ok "$($release.tag_name) · $($asset.name) · $([math]::Round($asset.size / 1MB, 1)) MB"

# 3. Unpack --------------------------------------------------------------------
Write-Step "安装到 $Dir"
if ((Test-Path $Dir) -and -not $Force) {
  $existing = Get-ChildItem $Dir -ErrorAction SilentlyContinue
  if ($existing) { Fail "目录已存在且非空：$Dir`n  加 -Force 覆盖安装，或换一个 -Dir" }
}
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dsbot-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null
$zip = Join-Path $tmp 'release.zip'
try {
  Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $zip -TimeoutSec 300
  Write-Ok "已下载 $([math]::Round((Get-Item $zip).Length / 1MB, 2)) MB"
  $unpacked = Join-Path $tmp 'unpacked'
  Expand-Archive -Path $zip -DestinationPath $unpacked -Force
  # The archive may hold the tree at its root, or inside one wrapper directory.
  $rootPath = $null
  if (Test-Path (Join-Path $unpacked 'service\bin\dsteam.mjs')) {
    $rootPath = $unpacked
  } else {
    $candidate = Get-ChildItem $unpacked -Directory |
      Where-Object { Test-Path (Join-Path $_.FullName 'service\bin\dsteam.mjs') } |
      Select-Object -First 1
    if ($candidate) { $rootPath = $candidate.FullName }
  }
  if (-not $rootPath) { Fail '压缩包结构不对：找不到 service/bin/dsteam.mjs' }
  New-Item -ItemType Directory -Force $Dir | Out-Null
  Copy-Item (Join-Path $rootPath '*') $Dir -Recurse -Force
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
foreach ($needed in 'plugin\index.js', 'service\bin\dsteam.mjs', 'service\miniapp\node\server.mjs', 'LICENSE') {
  if (-not (Test-Path (Join-Path $Dir $needed))) { Fail "安装不完整：缺少 $needed" }
}
Write-Ok '文件完整（plugin / service / docs / LICENSE）'

# 4. Self-check ----------------------------------------------------------------
Write-Step '自检：加载团队服务模块'
$probePath = Join-Path $env:TEMP 'dsbot-probe.mjs'
$probeJs = 'const url = new URL("file:///" + process.argv[2].replace(/\\/g, "/") + "/service/miniapp/node/server.mjs"); import(url.href).then((m) => { if (typeof m.start !== "function") process.exit(2); console.log("ok"); }).catch((e) => { console.error(e.message); process.exit(1); });'
Set-Content -Path $probePath -Value $probeJs -Encoding ascii
& node $probePath $Dir
if ($LASTEXITCODE -ne 0) { Fail '模块加载失败，安装可能不完整' }
Remove-Item $probePath -Force -ErrorAction SilentlyContinue
Write-Ok '模块可加载'

# 5. Next steps ----------------------------------------------------------------
Write-Host ''
Write-Host '  安装完成' -ForegroundColor Green
Write-Host ''
Write-Host '  ① 作为 DSH 插件（推荐）' -ForegroundColor Cyan
Write-Host "     DSH → 插件 → 添加插件 → 选择目录：$Dir\plugin"
Write-Host '     插件会自动起停团队服务，并把 21 个团队工具注册给 Agent。'
Write-Host ''
Write-Host '  ② 或直接独立运行' -ForegroundColor Cyan
Write-Host "     node `"$Dir\service\bin\dsteam.mjs`" --port $Port"
Write-Host "     然后打开 http://127.0.0.1:$Port/bot"
Write-Host '     （首次运行前：把 service\config.example.json 复制为 config.json 并填 api.apiKey）'
Write-Host ''

if ($Standalone) {
  Write-Step "以独立模式启动（端口 $Port）"
  $configPath = Join-Path $Dir 'service\config.json'
  if (-not (Test-Path $configPath)) {
    Copy-Item (Join-Path $Dir 'service\config.example.json') $configPath
    Write-Warn2 "已生成 $configPath，请填入 api.apiKey 后重启；现在先以空 Key 启动（只影响对话）"
  }
  Start-Process -FilePath 'node' -ArgumentList @((Join-Path $Dir 'service\bin\dsteam.mjs'), '--port', $Port) -WorkingDirectory (Join-Path $Dir 'service') -PassThru | ForEach-Object {
    Write-Ok "已启动，PID $($_.Id) · http://127.0.0.1:$Port/bot"
  }
}
