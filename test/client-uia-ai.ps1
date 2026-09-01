# Verify single-player AI mode: lobby -> AI room -> player move -> AI responds
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

function Send-Click($x, $y) {
    [M15]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 60
    [M15]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
    [M15]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
}

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

function Find-ButtonLike($win, $contains) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)
    foreach ($b in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
        if ($b.Current.Name -like "*$contains*") { return $b }
    }
    return $null
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
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
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

$win = $null
for ($i = 0; $i -lt 10 -and -not $win; $i++) {
    Start-Sleep -Milliseconds 500
    $win = Find-Window '对战平台 · 中国象棋'
}
if (-not $win) { Write-Host 'FAIL: window not found'; exit 1 }

# guest -> lobby
$ga = Wait-Button $win '游客体验' 10
if ($ga) { Invoke-Element $ga }
$lobby = Wait-Button $win '创建房间' 20
if (-not $lobby) { Write-Host 'FAIL: lobby'; exit 1 }
Write-Host 'PASS: lobby reached'

# start AI game
$aiBtn = Find-ButtonLike $win '人机对战'
if (-not $aiBtn) { Write-Host 'FAIL: AI button missing'; exit 1 }
Invoke-Element $aiBtn
if (-not (Wait-Button $win '离开房间' 15)) { Write-Host 'FAIL: AI room not entered'; exit 1 }
Write-Host 'PASS: AI room entered'

# ready + start (AI is auto-ready)
Invoke-Element (Wait-Button $win '就绪' 10)
$start = Wait-Button $win '开始对局' 10
if (-not $start) { Write-Host 'FAIL: start button'; exit 1 }
Invoke-Element $start
if (-not (Wait-Button $win '认输' 15)) { Write-Host 'FAIL: game not started'; exit 1 }
Write-Host 'PASS: AI game started'

# computer name visible in players info
if (-not (Find-Text $win '电脑')) { Write-Host 'FAIL: computer player not shown'; exit 1 }
Write-Host 'PASS: computer player shown'

# player (red) moves cannon (7,7)->(7,5) with topmost retry
$boardCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'XiangqiBoard')
$moved = $false
for ($attempt = 0; $attempt -lt 6 -and -not $moved; $attempt++) {
    [M15]::SetWindowPos([IntPtr]$win.Current.NativeWindowHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0010) | Out-Null
    Start-Sleep -Milliseconds 500
    $board = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $boardCond)
    $br = $board.Current.BoundingRectangle
    Send-Click ([int]($br.X + 44 + 7 * 60)) ([int]($br.Y + 44 + 7 * 60))
    Start-Sleep -Milliseconds 200
    Send-Click ([int]($br.X + 44 + 7 * 60)) ([int]($br.Y + 44 + 5 * 60))
    Start-Sleep -Milliseconds 800
    if (Find-Text $win '电脑思考中') { $moved = $true }
}
if (-not $moved) { Write-Host 'FAIL: player move or AI thinking not shown'; exit 1 }
Write-Host 'PASS: player moved, AI thinking shown'

# AI responds: move list grows to 2 moves
$move2 = Wait-Text $win '第2手' 15
if (-not $move2) { Write-Host 'FAIL: AI move not in move list'; exit 1 }
Write-Host "PASS: AI responded: $($move2.Current.Name)"

# back to player's turn: countdown shown again
$timer = Wait-Text $win '⏱' 10
if (-not $timer) { Write-Host 'FAIL: countdown missing after AI move'; exit 1 }
Write-Host "PASS: player turn resumed: $($timer.Current.Name)"

Write-Host ''
Write-Host 'SINGLE-PLAYER AI MODE VERIFIED'