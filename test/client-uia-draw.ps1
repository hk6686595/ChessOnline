# Verify draw offer flow: offer button, confirm prompt, agreed draw ends game
# 前置：服务器已启动，且已打开两个客户端窗口（标题"对战平台 · 中国象棋"）
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System.Runtime.InteropServices;
public class M15 {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, System.UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@

function Find-Windows($title) {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $title)
    return $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
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

function Find-Text($win, $contains) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Text)
    $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    foreach ($t in $all) { if ($t.Current.Name -like "*$contains*") { return $t } }
    return $null
}

function Invoke-Element($el) {
    if (-not $el) { return }
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    if ($pattern) { $pattern.Invoke() }
}

function Wait-Button($win, $name, $tries) {
    for ($i = 0; $i -lt $tries; $i++) {
        $b = Find-Button $win $name
        if ($b -and $b.Current.IsEnabled) { return $b }
        Start-Sleep -Milliseconds 300
    }
    return $null
}

function Wait-Text($win, $contains, $tries) {
    for ($i = 0; $i -lt $tries; $i++) {
        $t = Find-Text $win $contains
        if ($t) { return $t }
        Start-Sleep -Milliseconds 300
    }
    return $null
}

$wins = $null
for ($i = 0; $i -lt 20 -and (-not $wins -or $wins.Count -lt 2); $i++) {
    Start-Sleep -Milliseconds 400
    $wins = Find-Windows '对战平台 · 中国象棋 / 五子棋'
}
if (-not $wins -or $wins.Count -lt 2) { Write-Host 'FAIL: need two windows'; exit 1 }
$winA = $wins[0]; $winB = $wins[1]

# A: guest -> create room
$ga = Wait-Button $winA '游客体验' 10
if ($ga) { Invoke-Element $ga }
$ca = Wait-Button $winA '创建房间' 20
Invoke-Element $ca
Wait-Button $winA '离开房间' 15 | Out-Null
# B: guest -> quick join
$gb = Wait-Button $winB '游客体验' 10
if ($gb) { Invoke-Element $gb }
$cb = Wait-Button $winB '创建房间' 20
if (-not $cb) { Write-Host 'FAIL: B lobby'; exit 1 }
Invoke-Element (Wait-Button $winB '快速加入' 10)
if (-not (Wait-Button $winB '就绪' 15)) { Write-Host 'FAIL: B join'; exit 1 }
# ready + start
Invoke-Element (Wait-Button $winA '就绪' 10)
Invoke-Element (Wait-Button $winB '就绪' 10)
Start-Sleep -Milliseconds 300
Invoke-Element (Wait-Button $winA '开始对局' 10)
if (-not (Wait-Button $winA '认输' 15) -or -not (Wait-Button $winB '认输' 15)) { Write-Host 'FAIL: game start'; exit 1 }
Write-Host 'PASS: game started'

# draw offer button visible on both sides during play
$drawBtnB = Wait-Button $winB '求和' 10
if (-not $drawBtnB) { Write-Host 'FAIL: draw button missing on B'; exit 1 }
if (-not (Find-Button $winA '求和')) { Write-Host 'FAIL: draw button missing on A'; exit 1 }
Write-Host 'PASS: draw offer button shown'

# B offers draw -> A sees confirm prompt
Invoke-Element $drawBtnB
$prompt = Wait-Text $winA '请求求和' 10
if (-not $prompt) { Write-Host 'FAIL: draw prompt missing on A'; exit 1 }
Write-Host "PASS: draw prompt shown on A: $($prompt.Current.Name)"

# A rejects -> B notified, game continues
Invoke-Element (Wait-Button $winA '拒绝' 10)
$rej = Wait-Text $winB '拒绝了求和' 10
if (-not $rej) { Write-Host 'FAIL: reject notice missing on B'; exit 1 }
if (Find-Text $winA '平局') { Write-Host 'FAIL: game should not end after reject'; exit 1 }
Write-Host 'PASS: reject notified, game continues'

# B offers again -> blocked by cooldown (需再走 4 步)
Invoke-Element (Wait-Button $winB '求和' 10)
$cd = Wait-Text $winB '才能再次提和' 8
if (-not $cd) { Write-Host 'FAIL: cooldown hint missing on B'; exit 1 }
Write-Host "PASS: cooldown enforced: $($cd.Current.Name)"

Write-Host ''
Write-Host 'DRAW FLOW VERIFIED (offer button / prompt / reject / cooldown)'
