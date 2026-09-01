# Verify WPF client connects to the external tunnel
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
for ($i = 0; $i -lt 10 -and -not $win; $i++) { Start-Sleep -Milliseconds 500; $win = Find-Window '对战平台 · 中国象棋' }
if (-not $win) { Write-Host 'FAIL: window not found'; exit 1 }

# Set server URL to the external tunnel (Edit[0] = ServerBox)
$editCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit)
$edits = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
$vp = $edits[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
$vp.SetValue('https://5eb5fc8.r21.cpolar.top')
Start-Sleep -Milliseconds 300
Write-Host '外网地址已填入'

# Guest login
$guest = Find-Button $win '游客体验'
if ($guest) { Invoke-Element $guest }
$lobby = $null
for ($i = 0; $i -lt 40 -and -not $lobby; $i++) {
    Start-Sleep -Milliseconds 300
    $lobby = Find-Button $win '创建房间'
}
if (-not $lobby) { Write-Host 'FAIL: 外网登录失败（未进入大厅）'; exit 1 }
Write-Host 'PASS: 客户端通过外网隧道登录成功（进入大厅）'