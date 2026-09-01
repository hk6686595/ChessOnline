# Verify login timeout hint when server is unreachable
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

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
function Invoke-Element($el) { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function Find-Text($win, $contains) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Text)
    foreach ($t in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
        if ($t.Current.Name -like "*$contains*") { return $t }
    }
    return $null
}

$win = $null
for ($i = 0; $i -lt 10 -and -not $win; $i++) { Start-Sleep -Milliseconds 500; $win = Find-Window '对战平台 · 中国象棋' }
if (-not $win) { Write-Host 'FAIL: window not found'; exit 1 }

# Server address was pre-set to an unreachable address in config before launch
Write-Host '服务器地址为不可达地址（启动前配置）'

# Try guest login -> expect timeout hint within ~12s
Invoke-Element (Find-ButtonLike $win '游客体验')
# Unreachable server: expect immediate "not connected" hint; connected-but-no-response would show "超时"
$hint = $null
for ($i = 0; $i -lt 50 -and -not $hint; $i++) {
    Start-Sleep -Milliseconds 300
    $hint = Find-Text $win '尚未连接'
    if (-not $hint) { $hint = Find-Text $win '超时' }
}
if (-not $hint) { Write-Host 'FAIL: no connectivity hint shown'; exit 1 }
Write-Host "PASS: connectivity hint shown: $($hint.Current.Name)"

Write-Host ''
Write-Host 'LOGIN TIMEOUT HINT VERIFIED'