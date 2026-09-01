# Verify new register UI: validation + register flow + match history (mouse-only)
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

function Set-EditValue($win, $index, $value) {
    $editCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit)
    $edits = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
    $vp = $edits[$index].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue($value)
}

$win = $null
for ($i = 0; $i -lt 10 -and -not $win; $i++) {
    Start-Sleep -Milliseconds 500
    $win = Find-Window '对战平台 · 中国象棋'
}
if (-not $win) { Write-Host 'FAIL: window not found'; exit 1 }

# 1. Register tab
$tabReg = Find-Button $win '切换注册'
if (-not $tabReg) { Write-Host 'FAIL: register tab not found'; exit 1 }
Invoke-Element $tabReg
Start-Sleep -Milliseconds 400
if (-not (Find-Text $win '确认密码')) { Write-Host 'FAIL: register form not shown'; exit 1 }
Write-Host 'PASS: register form shown'

# 2. Empty form -> submit disabled
$regBtn = Find-Button $win '提交注册'
if (-not $regBtn) { Write-Host 'FAIL: submit button not found'; exit 1 }
if ($regBtn.Current.IsEnabled) { Write-Host 'FAIL: submit enabled on empty form'; exit 1 }
Write-Host 'PASS: submit disabled on empty form (validation)'

# 3. Invalid nickname -> still disabled
Set-EditValue $win 1 'a'
Start-Sleep -Milliseconds 300
if ((Find-Button $win '提交注册').Current.IsEnabled) { Write-Host 'FAIL: submit enabled with invalid nickname'; exit 1 }
Write-Host 'PASS: submit disabled with invalid nickname'

# 4. Fill test account -> enabled
$fill = Find-Button $win '填入测试账号'
if (-not $fill) { Write-Host 'FAIL: fill button missing'; exit 1 }
Invoke-Element $fill
Start-Sleep -Milliseconds 400
if (-not (Find-Button $win '提交注册').Current.IsEnabled) { Write-Host 'FAIL: submit still disabled after fill'; exit 1 }
Write-Host 'PASS: submit enabled after fill (valid form)'

# 5. Register -> 回到登录页（不自动登录），昵称已回填
Invoke-Element (Find-Button $win '提交注册')
$loginBtn = $null
for ($i = 0; $i -lt 30 -and -not $loginBtn; $i++) {
    Start-Sleep -Milliseconds 300
    $loginBtn = Find-Button $win '登 录'
}
if (-not $loginBtn) { Write-Host 'FAIL: not returned to login page after register'; exit 1 }
if (Find-Text $win '确认密码') { Write-Host 'FAIL: still on register form'; exit 1 }
Write-Host 'PASS: registered and returned to login page'

# 6. 手动登录 -> 大厅
Invoke-Element $loginBtn
$create = $null
for ($i = 0; $i -lt 40 -and -not $create; $i++) {
    Start-Sleep -Milliseconds 300
    $create = Find-Button $win '创建房间'
}
if (-not $create) { Write-Host 'FAIL: lobby not reached after login'; exit 1 }
Write-Host 'PASS: logged in and entered lobby'

# 6. Match history panel present
if (-not (Find-Text $win '我的战绩')) { Write-Host 'FAIL: my-matches panel missing'; exit 1 }
Write-Host 'PASS: my-matches panel present'

Write-Host ''
Write-Host 'NEW REGISTER UI + VALIDATION + MATCH HISTORY VERIFIED'