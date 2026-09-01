# 停止对战平台服务（服务器 + cpolar 隧道）
# 用法：powershell -ExecutionPolicy Bypass -File stop-external.ps1
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stopped = @()

# 0. 停服前先把 WAL 合并进主数据库文件（即使随后是强杀，数据也已落主文件 platform.db）
Write-Host '[0] 合并数据库 WAL 到主文件...'
try {
    $dbPath = Join-Path $root 'data\platform.db'
    node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();db.close()" $dbPath 2>&1 | Out-Null
    Write-Host '  数据库已合并（platform.db 已包含最新数据）' -ForegroundColor Green
} catch {
    Write-Host '  数据库合并失败（不影响停止服务，数据仍在 platform.db-wal 中，下次启动会自动恢复）' -ForegroundColor Yellow
}

# 1. 停止对战平台服务器（按 8080 监听端口精确定位，不会误杀其他 node 进程）
Write-Host '[1] 停止服务器 (8080)...'
$pids = @()
try {
    $conns = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
    $pids = @($conns | Select-Object -ExpandProperty OwningProcess -Unique)
} catch {
    # 兜底：用 netstat 解析
    $lines = netstat -ano | Select-String ':8080' | Select-String 'LISTENING'
    foreach ($l in $lines) {
        $pid = ($l.Line -split '\s+')[-1]
        if ($pid -match '^\d+$') { $pids += [int]$pid }
    }
    $pids = @($pids | Select-Object -Unique)
}
if ($pids.Count -gt 0) {
    foreach ($procId in $pids) {
        try {
            Stop-Process -Id $procId -Force -ErrorAction Stop
            Write-Host "  已停止 PID $procId"
            $stopped += $procId
        } catch {
            Write-Host "  停止 PID $procId 失败: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
} else {
    Write-Host '  8080 端口没有监听，服务器可能未运行'
}

# 1.1 复查：端口若仍被占用，兜底再杀一次
Start-Sleep -Milliseconds 500
$still = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $still) {
    $procId = $c.OwningProcess
    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Write-Host "  已兜底停止 PID $procId"
        $stopped += $procId
    } catch {
        Write-Host "  兜底停止 PID $procId 失败: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# 1.2 兜底：清理仍在运行的服务器 node 进程（按入口 src/index.ts 或编译产物 dist/index.js 定位）
$stray = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'src[/\\]index\.ts|dist[/\\]index\.js' }
foreach ($proc in $stray) {
    try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        Write-Host "  已清理残留服务器进程 PID $($proc.ProcessId)"
        $stopped += $proc.ProcessId
    } catch {
        Write-Host "  清理 PID $($proc.ProcessId) 失败: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# 2. 只停止项目内置 cpolar，保留 Windows 服务（可能正用于其它穿透）
Write-Host '[2] 停止项目内 cpolar...'
$cpolarDir = Join-Path $root 'cpolar'
$projectCpolar = Get-CimInstance Win32_Process -Filter "Name='cpolar.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like (Join-Path $cpolarDir '*')) }
if (-not $projectCpolar) {
    Write-Host '  没有项目内 cpolar 进程'
} else {
    foreach ($proc in $projectCpolar) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Host "  已停止 PID $($proc.ProcessId)"
            $stopped += $proc.ProcessId
        } catch {
            Write-Host "  停止 PID $($proc.ProcessId) 失败: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

Write-Host ''
if ($stopped.Count -gt 0) {
    Write-Host '==============================================' -ForegroundColor Cyan
    Write-Host "  已停止 $($stopped.Count) 个进程，服务已全部关闭" -ForegroundColor Green
    Write-Host '  外网地址将不可访问，如需恢复运行：' -ForegroundColor Yellow
    Write-Host '  powershell -ExecutionPolicy Bypass -File start-external.ps1' -ForegroundColor Yellow
    Write-Host '==============================================' -ForegroundColor Cyan
} else {
    Write-Host '  未发现需要停止的进程（服务器与 cpolar 均未运行）'
}
