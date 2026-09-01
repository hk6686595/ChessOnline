# 对战平台运行状态一键检查
# 用法：powershell -ExecutionPolicy Bypass -File check-status.ps1
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ok = 0; $bad = 0

function Check($name, $cond, $detail = '') {
    if ($cond) { $script:ok++; Write-Host "  [OK] $name $detail" -ForegroundColor Green }
    else { $script:bad++; Write-Host "  [!!] $name $detail" -ForegroundColor Red }
}

Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '  对战平台运行状态检查'
Write-Host '==============================================' -ForegroundColor Cyan

# 1. Node 服务器进程
Write-Host ""
Write-Host '[1] 服务器进程' -ForegroundColor Yellow
$node = Get-Process node -ErrorAction SilentlyContinue
Check 'Node 进程' ($null -ne $node) "($(@($node).Count) 个进程)"

# 2. 本机 8080 端口
Write-Host ""
Write-Host '[2] 本机服务 (8080)' -ForegroundColor Yellow
$local = $null
try { $local = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/api/health' -UseBasicParsing -TimeoutSec 5 } catch {}
Check '本机 /api/health' ($null -ne $local -and $local.StatusCode -eq 200) ($local.Content)
$rooms = $null
if ($local) { try { $rooms = ($local.Content | ConvertFrom-Json).rooms } catch {} }
Write-Host "       当前房间数: $rooms"

# 3. cpolar 进程
Write-Host ""
Write-Host '[3] cpolar 隧道进程' -ForegroundColor Yellow
$cpolar = Get-Process cpolar -ErrorAction SilentlyContinue
Check 'cpolar 进程' ($null -ne $cpolar) "($(@($cpolar).Count) 个进程)"

# 4. 隧道公网地址
Write-Host ""
Write-Host '[4] 外网隧道地址' -ForegroundColor Yellow
$url = $null
$logDir = Join-Path $root 'logs\cpolar'
$logText = ''
Get-ChildItem $logDir -Filter 'cpolar-tunnel.log*' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 6 |
    ForEach-Object {
        $t = Get-Content $_.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        if ($t) { $logText += "`n$t" }
    }
if ($logText) {
    $m = [regex]::Matches($logText, 'https://[a-z0-9]+(?:\.r\d+)?(?:\.vip)?\.cpolar\.(?:cn|top)')
    if ($m.Count -gt 0) { $url = $m[$m.Count - 1].Value }
}
if ($url) {
    Write-Host "       隧道地址: $url" -ForegroundColor Green
    # 5. 外网连通性（从本机走公网链路测试）
    Write-Host ""
    Write-Host '[5] 外网连通性（真实公网链路）' -ForegroundColor Yellow
    $ext = $null
    try { $ext = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 25 } catch {}
    Check '外网 /api/health' ($null -ne $ext -and $ext.StatusCode -eq 200) ($ext.Content)
} else {
    Write-Host "       未在 $logDir 找到隧道地址" -ForegroundColor Red
    Write-Host '       请确认已运行：start-external.ps1' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '==============================================' -ForegroundColor Cyan
if ($bad -eq 0) { Write-Host '  全部正常 ✅ 服务器与 cpolar 都在工作' -ForegroundColor Green }
else { Write-Host "  有 $bad 项异常，请按上面 [!!] 提示处理" -ForegroundColor Red }
Write-Host '==============================================' -ForegroundColor Cyan
