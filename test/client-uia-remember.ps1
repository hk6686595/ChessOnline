# Verify remember-account: register -> close -> reopen -> auto-filled -> login
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$ErrorActionPreference = 'Stop'

function Find-Window($title) {
    # 模糊匹配：窗口实际标题为「对战平台 · 中国象棋 / 五子棋」，避免精确匹配失效
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window)
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
    foreach ($w in $windows) {
        if ($w.Current.Name -like "*$title*") { return $w }
    }
    return $null
}
function Find-ButtonLike($win, $contains) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)
    foreach ($b in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
        if ($b.Current.Name -like "*$contains*") { return $b }
    }
    return $null
}
function Wait-ButtonLike($win, $contains, $tries) {
    for ($i = 0; $i -lt $tries; $i++) { $b = Find-ButtonLike $win $contains; if ($b) { return $b }; Start-Sleep -Milliseconds 300 }
    return $null
}
function Invoke-Element($el) {
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
}
function Close-Window($win) {
    $wp = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
    $wp.Close()
}

$exe = Join-Path $PSScriptRoot '..\client\XiangqiClient\bin\Debug\net10.0-windows7.0\中国象棋在线对战平台.exe'

# ---- Phase 1: register an account ----
Start-Process $exe
$win = $null
for ($i = 0; $i -lt 20 -and -not $win; $i++) { Start-Sleep -Milliseconds 500; $win = Find-Window '对战平台 · 中国象棋' }
if (-not $win) { Write-Host 'FAIL: window'; exit 1 }
Invoke-Element (Find-ButtonLike $win '切换注册' -ErrorAction SilentlyContinue)
Start-Sleep -Milliseconds 400
$fill = Wait-ButtonLike $win '填入测试账号' 10
if (-not $fill) { Write-Host 'FAIL: fill button'; exit 1 }
Invoke-Element $fill
Start-Sleep -Milliseconds 300
Invoke-Element (Wait-ButtonLike $win '提交注册' 10)
# 注册成功后返回登录页（不自动登录），昵称已回填
if (-not (Wait-ButtonLike $win '登 录' 20)) { Write-Host 'FAIL: not returned to login page after register'; exit 1 }
Write-Host 'PASS: account registered'
# 手动登录进入大厅
Invoke-Element (Find-ButtonLike $win '登 录')
if (-not (Wait-ButtonLike $win '创建房间' 20)) { Write-Host 'FAIL: login failed'; exit 1 }

# capture the account name from the user bar
$name = $null
$txtCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
foreach ($t in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $txtCond)) {
    if ($t.Current.Name -match '^\S+（\d+ 分）') { $name = $t.Current.Name -replace '（.*',''; break }
}
if (-not $name) { Write-Host 'FAIL: cannot read account name'; exit 1 }
Write-Host "账号: $name"

# close window normally (saves config)
Start-Sleep -Milliseconds 500
Close-Window $win
Start-Sleep -Milliseconds 1500
$cfg = Join-Path $env:APPDATA 'XiangqiClient\config.json'
if (-not (Test-Path $cfg)) { Write-Host 'FAIL: config.json not saved'; exit 1 }
$cfgJson = Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json
if ($cfgJson.savedName -ne $name) { Write-Host "FAIL: savedName mismatch: $($cfgJson.savedName)"; exit 1 }
if (-not $cfgJson.savedPassword) { Write-Host 'FAIL: savedPassword empty'; exit 1 }
if ($cfgJson.rememberAccount -ne $true) { Write-Host 'FAIL: rememberAccount false'; exit 1 }
Write-Host 'PASS: config saved (name/password/remember)'

# ---- Phase 2: reopen, should auto-fill ----
Start-Process $exe
$win2 = $null
for ($i = 0; $i -lt 10 -and -not $win2; $i++) { Start-Sleep -Milliseconds 500; $win2 = Find-Window '对战平台 · 中国象棋' }
if (-not $win2) { Write-Host 'FAIL: window2'; exit 1 }
Start-Sleep -Milliseconds 800

# Reopen: token may auto-login into lobby; log out to reach the login page
Start-Sleep -Milliseconds 1000
$logout = Find-ButtonLike $win2 '退出登录'
if ($logout) { Invoke-Element $logout; Start-Sleep -Milliseconds 1000; Write-Host 'NOTE: auto-logged-in via token, logged out to test form' }
# Login form should be pre-filled: click login directly and expect lobby
$loginBtn = Wait-ButtonLike $win2 '登 录' 10
if (-not $loginBtn) { Write-Host 'FAIL: login button'; exit 1 }
Invoke-Element $loginBtn
if (-not (Wait-ButtonLike $win2 '创建房间' 20)) { Write-Host 'FAIL: account not auto-filled (login failed)'; exit 1 }
Write-Host 'PASS: account auto-filled and login succeeded'

Close-Window $win2
Write-Host ''
Write-Host 'REMEMBER ACCOUNT VERIFIED'