# Verify new features: move list, countdown, undo flow, chat bubbles
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System.Runtime.InteropServices;
public class M14 {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, System.UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@

function Send-Click($x, $y) {
    [M14]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 60
    [M14]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
    [M14]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
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

function Set-EditValue($win, $index, $value) {
    $editCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit)
    $edits = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
    $vp = $edits[$index].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue($value)
}

$wins = $null
for ($i = 0; $i -lt 20 -and (-not $wins -or $wins.Count -lt 2); $i++) {
    Start-Sleep -Milliseconds 400
    $wins = Find-Windows '对战平台 · 中国象棋'
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

# identify red/black
$redWin = $null; $blackWin = $null
for ($i = 0; $i -lt 15 -and (-not $redWin -or -not $blackWin); $i++) {
    Start-Sleep -Milliseconds 300
    foreach ($w in (Find-Windows '对战平台 · 中国象棋')) {
        if (Find-Text $w '轮到你了') { $redWin = $w }
        elseif (Find-Text $w '等待') { $blackWin = $w }
    }
}
if (-not $redWin -or -not $blackWin) { Write-Host 'FAIL: red/black identify'; exit 1 }
Write-Host 'PASS: red/black identified'

# countdown visible
$timerTxt = Find-Text $redWin '⏱'
if (-not $timerTxt) { Write-Host 'FAIL: countdown missing'; exit 1 }
Write-Host "PASS: countdown shown: $($timerTxt.Current.Name)"

# red moves cannon (7,7)->(7,5) with topmost retry
$boardCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'XiangqiBoard')
$moved = $false
for ($attempt = 0; $attempt -lt 6 -and -not $moved; $attempt++) {
    [M14]::SetWindowPos([IntPtr]$redWin.Current.NativeWindowHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
    Start-Sleep -Milliseconds 500
    $board = $redWin.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $boardCond)
    $br = $board.Current.BoundingRectangle
    Send-Click ([int]($br.X + 44 + 7 * 60)) ([int]($br.Y + 44 + 7 * 60))
    Start-Sleep -Milliseconds 200
    Send-Click ([int]($br.X + 44 + 7 * 60)) ([int]($br.Y + 44 + 5 * 60))
    Start-Sleep -Milliseconds 600
    if (Find-Text $blackWin '轮到你了') { $moved = $true }
}
if (-not $moved) { Write-Host 'FAIL: red move'; exit 1 }
Write-Host 'PASS: red moved'

# move list shows notation
$moveItem = Wait-Text $redWin '第1手' 10
if (-not $moveItem -or $moveItem.Current.Name -notlike '*炮*进*') {
    Write-Host "FAIL: move list missing. got: $($moveItem.Current.Name)"
    exit 1
}
Write-Host "PASS: move list shows: $($moveItem.Current.Name)"

# countdown ticking (value changes)
$t1 = (Find-Text $redWin '⏱').Current.Name
Start-Sleep -Milliseconds 2100
$t2 = (Find-Text $redWin '⏱').Current.Name
if ($t1 -eq $t2) { Write-Host 'FAIL: countdown not ticking'; exit 1 }
Write-Host "PASS: countdown ticking ($t1 -> $t2)"

# black requests undo -> red sees prompt -> red agrees -> board reverts
$undoBtn = Wait-Button $blackWin '悔棋' 10
if (-not $undoBtn) { Write-Host 'FAIL: undo button missing'; exit 1 }
Invoke-Element $undoBtn
$prompt = Wait-Text $redWin '请求悔棋' 10
if (-not $prompt) { Write-Host 'FAIL: undo prompt missing on red'; exit 1 }
Write-Host 'PASS: undo prompt shown on red'
Invoke-Element (Wait-Button $redWin '同意' 10)
$reverted = Wait-Text $redWin '第0手' 3
Start-Sleep -Milliseconds 800
if (Find-Text $redWin '第1手') { Write-Host 'FAIL: move not reverted'; exit 1 }
Write-Host 'PASS: undo done (move list reverted)'

# chat bubble: black sends, red sees
$chatInput = $blackWin.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
$vp = $chatInput.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
$vp.SetValue('测试消息123')
Invoke-Element (Wait-Button $blackWin '发送' 10)
$bubble = Wait-Text $redWin '测试消息123' 10
if (-not $bubble) { Write-Host 'FAIL: chat bubble not received'; exit 1 }
Write-Host 'PASS: chat bubble delivered'

Write-Host ''
Write-Host 'NEW FEATURES VERIFIED (move list / countdown / undo / chat bubbles)'