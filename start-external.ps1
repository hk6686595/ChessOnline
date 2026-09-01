# 一键启动：对战平台服务器 + cpolar 外网隧道（启动后自动打印最新外网地址）
# 用法：powershell -ExecutionPolicy Bypass -File start-external.ps1
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$cpolarDir = Join-Path $root 'cpolar'
$cpolar = Join-Path $cpolarDir 'cpolar.exe'
$config = Join-Path $cpolarDir 'cpolar.yml'
$cpolarLogDir = Join-Path $root 'logs\cpolar'
New-Item -ItemType Directory -Path $cpolarLogDir -Force | Out-Null
$logFile = Join-Path $cpolarLogDir 'cpolar-tunnel.log'

function Stop-ProjectCpolar {
    Get-CimInstance Win32_Process -Filter "Name='cpolar.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like (Join-Path $cpolarDir '*')) } |
        ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { }
        }
}

function Get-CpolarLogText {
    $parts = New-Object System.Collections.Generic.List[string]
    Get-ChildItem $cpolarLogDir -Filter 'cpolar-tunnel.log*' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 6 |
        ForEach-Object {
            $t = Get-Content $_.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
            if ($t) { [void]$parts.Add($t) }
        }
    if ($parts.Count -eq 0) { return '' }
    return ($parts -join "`n")
}

function Get-HttpsTunnelFromLog {
    $log = Get-CpolarLogText
    if (-not $log) { return $null }
    $m = [regex]::Matches($log, 'https://[a-z0-9]+(?:\.r\d+)?(?:\.vip)?\.cpolar\.(?:cn|top)')
    if ($m.Count -eq 0) { return $null }
    return $m[$m.Count - 1].Value
}

function Get-CpolarLogHint {
    $log = Get-CpolarLogText
    if (-not $log) { return $null }
    if ($log -match 'authToken auth failed') { return 'cpolar 返回 authtoken 无效，请核对 cpolar\cpolar.yml' }
    if ($log -match 'StartProxy.*i/o timeout') { return '隧道已建立，但数据通道超时（本机 Clash/TUN 代理常会拦截 cpolar）。请让 cpolar 走直连后再试。' }
    return $null
}

function Test-TunnelUrl([string]$candidate) {
    try {
        $r = Invoke-WebRequest -Uri "$candidate/api/health" -UseBasicParsing -TimeoutSec 10
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Ensure-CpolarConfig {
    if (-not (Test-Path $config)) { return $false }
    $hit = Select-String -Path $config -Pattern '^\s*authtoken:\s*(\S+)' | Select-Object -Last 1
    if (-not $hit) { return $false }
    $v = $hit.Matches.Groups[1].Value.Trim().Trim('"').Trim("'")
    if (-not $v -or $v -match '在此填入|^<') { return $false }
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [IO.File]::WriteAllText($config, "authtoken: $v$([Environment]::NewLine)", $utf8)
    return $true
}

# 0. 只停项目内置 cpolar，不动 Windows 服务（系统服务可能正在穿透 3389/8080，强杀会报「拒绝访问」）
Stop-ProjectCpolar
Write-Host '[0] 已清理项目内 cpolar 进程'

# 1. 启动服务器（必须走 npm.cmd：Start-Process npm 会命中无扩展名的 npm / npm.ps1，被记事本打开）
$npmCmd = $null
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($npm) { $npmCmd = $npm.Source }
if (-not $npmCmd) { $npmCmd = Join-Path $env:ProgramFiles 'nodejs\npm.cmd' }
$server = Start-Process -FilePath $npmCmd -ArgumentList 'start' -WorkingDirectory $root -WindowStyle Hidden -PassThru
Write-Host "[1] 服务器已启动 (PID $($server.Id))，等待就绪..."
Start-Sleep -Seconds 3

$url = $null

# 2. 始终用项目内 token + 内置 cpolar.exe（不复用系统服务，避免仍走旧账号隧道）
if (-not (Test-Path $cpolar)) {
    Write-Host '  未找到项目内置 cpolar\cpolar.exe' -ForegroundColor Red
} elseif (-not (Ensure-CpolarConfig)) {
    Write-Host '  未配置 cpolar authtoken。请先绑定账号（只需一次）：' -ForegroundColor Yellow
    Write-Host "  .\cpolar\cpolar.exe authtoken <你的token> -config cpolar\cpolar.yml" -ForegroundColor Yellow
    Write-Host '  然后重新运行本脚本。' -ForegroundColor Yellow
} else {
    try { Remove-Item $logFile -Force -ErrorAction SilentlyContinue } catch { }
    Get-ChildItem $cpolarLogDir -Filter 'cpolar-tunnel.log*' -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
    $arg = @('http', '8080', "-log=$logFile", "-config=$config", '-inspect-addr=127.0.0.1:4050')
    Start-Process $cpolar -ArgumentList $arg -WindowStyle Hidden
    Write-Host '[2] 使用项目 cpolar.yml 中的 token 启动隧道...'

    $waitStart = Get-Date
    $deadline = $waitStart.AddSeconds(90)
    $lastCandidate = $null
    $lastTryTime = $null
    $lastProgress = $waitStart
    while (-not $url -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (-not $lastCandidate -and ((Get-Date) - $lastProgress).TotalSeconds -ge 8) {
            Write-Host ('  等待隧道地址… 已 {0} 秒' -f [int]((Get-Date) - $waitStart).TotalSeconds)
            $lastProgress = Get-Date
        }
        $authFail = Get-CpolarLogHint
        if ($authFail -and $authFail -match 'authtoken 无效') {
            Write-Host "  $authFail" -ForegroundColor Red
            break
        }
        $candidate = Get-HttpsTunnelFromLog
        if (-not $candidate) { continue }
        $now = Get-Date
        $shouldTry = ($candidate -ne $lastCandidate) -or (-not $lastTryTime) -or (($now - $lastTryTime).TotalSeconds -ge 5)
        if (-not $shouldTry) { continue }
        $lastCandidate = $candidate
        $lastTryTime = $now
        Write-Host "  检测到地址 $candidate"
        if (Test-TunnelUrl $candidate) { $url = $candidate }
        else {
            Write-Host '  本机访问公网地址未通过（外网客户端仍可用该地址）' -ForegroundColor Yellow
            $url = $candidate
            break
        }
    }
    if (-not $url) {
        $hint = Get-CpolarLogHint
        Write-Host '  未能取得可用外网地址，请查看:' -ForegroundColor Red
        Write-Host "  $cpolarLogDir" -ForegroundColor Yellow
        if ($hint) { Write-Host "  $hint" -ForegroundColor Yellow }
    }
}

if ($url) {
    Write-Host ''
    Write-Host '=================================================='
    Write-Host "  外网地址: $url" -ForegroundColor Green
    Write-Host '  客户端登录页"服务器地址"填上面的 HTTPS 地址'
    Write-Host '  数据管理页: <地址>/admin'
    Write-Host '=================================================='
    try {
        $r = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 20
        Write-Host "  外网连通性: 正常 ($($r.Content))" -ForegroundColor Green
    } catch {
        Write-Host '  外网连通性: 暂时无法访问（隧道可能还在建立，稍等或查看日志）' -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host "提示：本机地址 http://127.0.0.1:8080 ；状态检查：powershell -ExecutionPolicy Bypass -File check-status.ps1"
Write-Host ''
Write-Host '  服务正在后台运行，此窗口保持打开以便查看外网地址。' -ForegroundColor Cyan
Write-Host '  按 [S] 停止服务并退出；按 [回车] 保持运行...' -ForegroundColor Cyan
$key = Read-Host
if ($key -eq 's' -or $key -eq 'S') {
    Write-Host ''
    & (Join-Path $root 'stop-external.ps1')
}
