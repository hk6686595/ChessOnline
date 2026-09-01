# Verify matchmaking flow: both clients queue -> paired into a room and game auto-starts
# 前置：服务器已启动，且已打开两个客户端窗口（标题含"对战平台 · 中国象棋"）
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Find-Windows($title) {
    # 模糊匹配：窗口实际标题为「对战平台 · 中国象棋 / 五子棋」，避免精确匹配失效
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window)
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
    $list = @()
    foreach ($w in $windows) {
        if ($w.Current.Name -like "*$title*") { $list += $w }
    }
    return $list
}

function Find-Button($win, $name) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)
    foreach ($b in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
        if ($b.Current.Name -like "*$name*") { return $b }
    }
    return $null
}

function Find-Text($win, $name) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Text)
    foreach ($t in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
        if ($t.Current.Name -like "*$name*") { return $t }
    }
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
        if ($b) { return $b }
        Start-Sleep -Milliseconds 300
    }
    return $null
}

function Wait-Text($win, $name, $tries) {
    for ($i = 0; $i -lt $tries; $i++) {
        $t = Find-Text $win $name
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
if (-not $wins -or $wins.Count -lt 2) { Write-Host 'FAIL: need two windows'; exit 1 }
$winA = $wins[0]; $winB = $wins[1]

# A: guest -> lobby
$guestA = Wait-Button $winA '游客体验' 30
if (-not $guestA) { Write-Host 'FAIL: A guest button'; exit 1 }
Invoke-Element $guestA
if (-not (Wait-Button $winA '创建房间' 20)) { Write-Host 'FAIL: A lobby'; exit 1 }
Write-Host 'PASS: A in lobby'

# B: guest -> lobby
$guestB = Wait-Button $winB '游客体验' 30
if (-not $guestB) { Write-Host 'FAIL: B guest button'; exit 1 }
Invoke-Element $guestB
if (-not (Wait-Button $winB '创建房间' 20)) { Write-Host 'FAIL: B lobby'; exit 1 }
Write-Host 'PASS: B in lobby'

# match button must be enabled now
$matchBtnA = Wait-Button $winA '一键匹配' 10
if (-not $matchBtnA) { Write-Host 'FAIL: A match button not found'; exit 1 }
if (-not $matchBtnA.Current.IsEnabled) { Write-Host 'FAIL: A match button should be enabled'; exit 1 }
Write-Host 'PASS: match button enabled'

# both enqueue
Invoke-Element $matchBtnA
$matchBtnB = Wait-Button $winB '一键匹配' 10
if (-not $matchBtnB) { Write-Host 'FAIL: B match button not found'; exit 1 }
Invoke-Element $matchBtnB

# paired -> both enter room and game auto-starts (认输 button appears in room view during play)
if (-not (Wait-Button $winA '认输' 40)) { Write-Host 'FAIL: A did not enter started game'; exit 1 }
Write-Host 'PASS: A matched and game started'
if (-not (Wait-Button $winB '认输' 40)) { Write-Host 'FAIL: B did not enter started game'; exit 1 }
Write-Host 'PASS: B matched and game started'

# board turn hint present on at least one side
$turnA = Wait-Text $winA '轮到' 10
$turnB = Wait-Text $winB '轮到' 10
if (-not $turnA -and -not $turnB) { Write-Host 'FAIL: no turn hint on either side'; exit 1 }
Write-Host 'PASS: turn hint shown'

Write-Host ''
Write-Host 'MATCHMAKING FLOW VERIFIED (enqueue / paired / auto-start)'
