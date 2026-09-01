# Two-client UI test: B joins A's room, both ready, game starts, A makes a move
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System.Runtime.InteropServices;
public class Mouse2 {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, System.UIntPtr dwExtraInfo);
}
"@

function Send-Click($x, $y) {
    [Mouse2]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 60
    [Mouse2]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)  # LEFTDOWN
    [Mouse2]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)  # LEFTUP
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
        if ($b) { return $b }
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

# ---- find the two client windows ----
$wins = $null
for ($i = 0; $i -lt 20 -and (-not $wins -or $wins.Count -lt 2); $i++) {
    Start-Sleep -Milliseconds 400
    $wins = Find-Windows '对战平台 · 中国象棋'
}
if (-not $wins -or $wins.Count -lt 2) { Write-Host 'FAIL: need two client windows (start second instance first)'; exit 1 }

# Window A = the one already in a room (has 离开房间 button), B = the other
$winA = $null; $winB = $null
foreach ($w in $wins) {
    if (Find-Button $w '离开房间') { $winA = $w } else { $winB = $w }
}
if (-not $winA -or -not $winB) { Write-Host 'FAIL: cannot identify windows (A must be in a room)'; exit 1 }
Write-Host 'PASS: two client windows identified'

# ---- B: guest login -> lobby ----
$guest = Wait-Button $winB '游客体验' 10
if ($guest) {
    Invoke-Element $guest
    Write-Host 'PASS: B clicked guest'
} else {
    Write-Host 'NOTE: B has no guest button (already logged in)'
}
$create = Wait-Button $winB '创建房间' 20
if (-not $create) { Write-Host 'FAIL: B lobby not reached'; exit 1 }
Write-Host 'PASS: B in lobby'

# ---- B: find the room list item and double-click to join ----
$listCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::ListItem)
$item = $null
for ($i = 0; $i -lt 20 -and -not $item; $i++) {
    Start-Sleep -Milliseconds 300
    $items = $winB.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCond)
    foreach ($it in $items) {
        if ($it.Current.Name -like '*象棋*') { $item = $it; break }
    }
}
if (-not $item) { Write-Host 'FAIL: no room in B list'; exit 1 }
$r = $item.Current.BoundingRectangle
Send-DoubleClick ([int]($r.X + $r.Width / 2)) ([int]($r.Y + $r.Height / 2))
Write-Host "PASS: B double-clicked room at ($($r.X),$($r.Y))"
Start-Sleep -Milliseconds 1200

# ---- both ready ----
$readyA = Wait-Button $winA '就绪' 10
$readyB = Wait-Button $winB '就绪' 10
if (-not $readyA -or -not $readyB) { Write-Host 'FAIL: ready buttons not found'; exit 1 }
Invoke-Element $readyA
Start-Sleep -Milliseconds 300
Invoke-Element $readyB
Start-Sleep -Milliseconds 300
Write-Host 'PASS: both players ready'

# ---- A (owner) starts ----
$start = Wait-Button $winA '开始对局' 10
if (-not $start) { Write-Host 'FAIL: start button not found (maybe not all ready)'; exit 1 }
Invoke-Element $start
Write-Host 'PASS: game started by A'

# ---- wait for surrender buttons (game running on both) ----
$surA = Wait-Button $winA '认输' 15
$surB = Wait-Button $winB '认输' 15
if (-not $surA -or -not $surB) { Write-Host 'FAIL: game not running on both'; exit 1 }
Write-Host 'PASS: game running on both clients'

# ---- A moves: red cannon (7,7) -> (7,5) ----
$boardCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'XiangqiBoard')
$boardA = $winA.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $boardCond)
if (-not $boardA) { Write-Host 'FAIL: board A not found'; exit 1 }
$br = $boardA.Current.BoundingRectangle
# cell (7,7): X = Pad + 7*Cell, Y = Pad + 7*Cell with Pad=44, Cell=60
Send-Click ([int]($br.X + 44 + 7 * 60)) ([int]($br.Y + 44 + 7 * 60))  # select red cannon at (7,7)
Start-Sleep -Milliseconds 200
Send-Click ([int]($br.X + 44 + 7 * 60)) ([int]($br.Y + 44 + 5 * 60))  # move to (7,5)
Write-Host 'PASS: A moved red cannon (7,7)->(7,5)'

# verify B's turn text changed (B is black, after A's move B should see 轮到你了)
$turnB = Wait-Text $winB '轮到你了' 15
if (-not $turnB) {
    Write-Host 'NOTE: B turn text not matched; dumping B status texts:'
    $tc = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Text)
    foreach ($t in $winB.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tc)) {
        Write-Host "  text: $($t.Current.Name)"
    }
    exit 1
}
Write-Host 'PASS: B sees its turn (move propagated)'

Write-Host ''
Write-Host 'TWO-CLIENT UIA GAME FLOW VERIFIED'
