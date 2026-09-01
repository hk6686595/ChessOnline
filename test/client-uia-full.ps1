# Full two-client UI test: A builds room, B joins, both ready, start, A moves, B sees turn
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System.Runtime.InteropServices;
public class Mouse3 {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, System.UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@

# Move the two windows to non-overlapping positions (works without foreground focus)
function Place-Windows($winA, $winB) {
    [Mouse3]::SetWindowPos([IntPtr]$winA.Current.NativeWindowHandle, [IntPtr]::Zero, 0, 0, 0, 0, 0x0001 -bor 0x0004) | Out-Null
    [Mouse3]::SetWindowPos([IntPtr]$winB.Current.NativeWindowHandle, [IntPtr]::Zero, 0, 780, 0, 0, 0x0001 -bor 0x0004) | Out-Null
    Start-Sleep -Milliseconds 400
}

function Bring-Front($win) {
    [Mouse3]::SetForegroundWindow([IntPtr]$win.Current.NativeWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 200
}

function Send-Click($x, $y) {
    [Mouse3]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 60
    [Mouse3]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
    [Mouse3]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
}

function Send-DoubleClick($x, $y) {
    Send-Click $x $y
    Start-Sleep -Milliseconds 80
    Send-Click $x $y
}

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
    foreach ($t in $all) {
        if ($t.Current.Name -like "*$contains*") { return $t }
    }
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

$wins = $null
for ($i = 0; $i -lt 20 -and (-not $wins -or $wins.Count -lt 2); $i++) {
    Start-Sleep -Milliseconds 400
    $wins = Find-Windows '对战平台 · 中国象棋'
}
if (-not $wins -or $wins.Count -lt 2) { Write-Host 'FAIL: need two client windows'; exit 1 }
$winA = $wins[0]; $winB = $wins[1]
Write-Host "PASS: two windows (A PID=$($winA.Current.ProcessId), B PID=$($winB.Current.ProcessId))"
Place-Windows $winA $winB

# ---- A: guest -> lobby -> create room ----
Bring-Front $winA
$ga = Wait-Button $winA '游客体验' 10
if ($ga) { Invoke-Element $ga }
$ca = Wait-Button $winA '创建房间' 20
if (-not $ca) { Write-Host 'FAIL: A lobby not reached'; exit 1 }
Invoke-Element $ca
$la = Wait-Button $winA '离开房间' 15
if (-not $la) { Write-Host 'FAIL: A room view not reached'; exit 1 }
Write-Host 'PASS: A created room'

# ---- B: guest -> lobby ----
Bring-Front $winB
$gb = Wait-Button $winB '游客体验' 10
if ($gb) { Invoke-Element $gb }
$cb = Wait-Button $winB '创建房间' 20
if (-not $cb) { Write-Host 'FAIL: B lobby not reached'; exit 1 }
Write-Host 'PASS: B in lobby'

# ---- B: click quick-join (mouse-synthetic Invoke is reliable in this env) ----
$quickJoin = Wait-Button $winB '快速加入' 10
if (-not $quickJoin) { Write-Host 'FAIL: quick-join button not found'; exit 1 }
Invoke-Element $quickJoin
$rb = Wait-Button $winB '就绪' 15
if (-not $rb) { Write-Host 'FAIL: B did not join the room'; exit 1 }
Write-Host 'PASS: B joined room'

# ---- both ready, A starts ----
Bring-Front $winA
$readyA = Wait-Button $winA '就绪' 10
if (-not $readyA) { Write-Host 'FAIL: A ready button missing'; exit 1 }
Invoke-Element $readyA
Start-Sleep -Milliseconds 300
Bring-Front $winB
$readyB = Wait-Button $winB '就绪' 10
if (-not $readyB) { Write-Host 'FAIL: B ready button missing'; exit 1 }
Invoke-Element $readyB
Start-Sleep -Milliseconds 300
Write-Host 'PASS: both ready'
Bring-Front $winA
$start = Wait-Button $winA '开始对局' 10
if (-not $start) { Write-Host 'FAIL: start button not enabled'; exit 1 }
Invoke-Element $start
$surA = Wait-Button $winA '认输' 15
$surB = Wait-Button $winB '认输' 15
if (-not $surA -or -not $surB) { Write-Host 'FAIL: game not started on both'; exit 1 }
Write-Host 'PASS: game started on both clients'

# ---- Red player (the one whose turn banner says 轮到你了) makes the first move ----
# Identify red vs black dynamically: window order is unstable in this env
$redWin = $null; $blackWin = $null
for ($i = 0; $i -lt 20 -and (-not $redWin -or -not $blackWin); $i++) {
    Start-Sleep -Milliseconds 300
    $wins2 = Find-Windows '对战平台 · 中国象棋'
    $redWin = $null; $blackWin = $null
    foreach ($w in $wins2) {
        if (Find-Text $w '轮到你了') { $redWin = $w }
        elseif (Find-Text $w '等待') { $blackWin = $w }
    }
}
if (-not $redWin -or -not $blackWin) { Write-Host 'FAIL: cannot identify red/black windows'; exit 1 }
Write-Host "PASS: red window identified (PID=$($redWin.Current.ProcessId))"

# Move both windows to fixed, non-overlapping positions and raise red to topmost,
# then click red's board (synthetic mouse events land on the topmost window)
[Mouse3]::SetWindowPos([IntPtr]$redWin.Current.NativeWindowHandle, [IntPtr]::Zero, 0, 0, 0, 0, 0x0001 -bor 0x0004) | Out-Null
[Mouse3]::SetWindowPos([IntPtr]$blackWin.Current.NativeWindowHandle, [IntPtr]::Zero, 0, 780, 0, 0, 0x0001 -bor 0x0004) | Out-Null
Start-Sleep -Milliseconds 300
$boardCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'XiangqiBoard')
$moved = $false
for ($attempt = 0; $attempt -lt 6 -and -not $moved; $attempt++) {
    [Mouse3]::SetWindowPos([IntPtr]$redWin.Current.NativeWindowHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0010) | Out-Null
    Start-Sleep -Milliseconds 500
    $boardRed = $redWin.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $boardCond)
    if (-not $boardRed) { Write-Host 'FAIL: red board not found'; exit 1 }
    $br = $boardRed.Current.BoundingRectangle
    Send-Click ([int]($br.X + 44 + 7 * 60)) ([int]($br.Y + 44 + 7 * 60))
    Start-Sleep -Milliseconds 200
    Send-Click ([int]($br.X + 44 + 7 * 60)) ([int]($br.Y + 44 + 5 * 60))
    Start-Sleep -Milliseconds 600
    if (Find-Text $blackWin '轮到你了') { $moved = $true }
}
if (-not $moved) { Write-Host 'FAIL: red move did not propagate (after retries)'; exit 1 }
Write-Host 'PASS: red moved cannon (7,7)->(7,5)'

# ---- black should now see its turn ----
$turnB = Wait-Text $blackWin '轮到你了' 15
if (-not $turnB) {
    Write-Host 'NOTE: black turn text not found; dumping black texts:'
    $tc = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Text)
    foreach ($t in $blackWin.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tc)) {
        Write-Host "  text: $($t.Current.Name)"
    }
    exit 1
}
Write-Host 'PASS: black sees its turn (move propagated through server)'

# ---- black surrenders -> game over -> red leaves room and match history shows the win ----
$sur = Wait-Button $blackWin '认输' 10
if (-not $sur) { Write-Host 'FAIL: surrender button missing'; exit 1 }
Invoke-Element $sur
Start-Sleep -Milliseconds 1200
$winBanner = Wait-Text $redWin '你赢了' 10
if (-not $winBanner) { Write-Host 'FAIL: red did not see the win banner'; exit 1 }
Write-Host 'PASS: red sees the win banner (game over)'

# red leaves the room back to lobby, then match history must show the win
$leave = Wait-Button $redWin '离开房间' 10
if (-not $leave) { Write-Host 'FAIL: leave button missing'; exit 1 }
Invoke-Element $leave
Start-Sleep -Milliseconds 1200
$winMark = Wait-Text $redWin '✅ 胜' 15
if (-not $winMark) {
    Write-Host 'NOTE: red win not recorded in match history; dumping red texts:'
    $tc = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Text)
    foreach ($t in $redWin.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tc)) {
        Write-Host "  text: $($t.Current.Name)"
    }
    exit 1
}
Write-Host 'PASS: red match history shows the win after surrender'

Write-Host ''
Write-Host 'TWO-CLIENT FULL GAME FLOW VERIFIED'
