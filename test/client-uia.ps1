# Drive the WPF client via UI Automation to verify the core flow
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

function Find-Button($win, $name) {
    $cond = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button)),
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, $name)))
    return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

function Invoke-Element($el) {
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
}

$win = $null
for ($i = 0; $i -lt 30 -and -not $win; $i++) {
    Start-Sleep -Milliseconds 1000
    $win = Find-Window '对战平台 · 中国象棋'
}
if (-not $win) { Write-Host 'FAIL: window not found'; exit 1 }
Write-Host 'PASS: client window found'

# 1. Click guest entry
$guest = $null
for ($i = 0; $i -lt 40 -and -not $guest; $i++) {
    Start-Sleep -Milliseconds 500
    $guest = Find-Button $win '游客体验'
}
if (-not $guest) { Write-Host 'FAIL: guest button not found'; exit 1 }
Invoke-Element $guest
Write-Host 'PASS: clicked guest'

# 2. Wait for lobby (create room button)
$create = $null
for ($i = 0; $i -lt 60 -and -not $create; $i++) {
    Start-Sleep -Milliseconds 500
    $create = Find-Button $win '创建房间'
}
if (-not $create) { Write-Host 'FAIL: lobby not reached'; exit 1 }
Write-Host 'PASS: lobby reached (create-room button visible)'

# 3. Create a room
Invoke-Element $create
Start-Sleep -Milliseconds 1000

# 4. Verify room view (leave-room button)
$leave = Find-Button $win '离开房间'
if (-not $leave) { Write-Host 'FAIL: room view not reached'; exit 1 }
Write-Host 'PASS: room view reached'

# 5. Verify the board control exists
$boardCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'XiangqiBoard')
$board = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $boardCond)
if (-not $board) { Write-Host 'FAIL: board control not found'; exit 1 }
Write-Host 'PASS: xiangqi board control present'

Write-Host ''
Write-Host 'UIA flow verified: login -> lobby -> create room -> room view (board)'
