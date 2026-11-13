# Drives Brave's own interface through UI Automation, without taking focus:
#   -Action menu      open the app menu
#   -Action omnibox   put -Text into the address bar so its dropdown opens
#   -Action list      print the buttons Brave's own interface offers (kind, class, name)
#   -Action press     press the first button whose name matches the pattern in -Text
param([Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][ValidateSet('menu', 'omnibox', 'list', 'press')][string]$Action, [string]$Text = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$pidCond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $ProcessId)
function Kind($e) { $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', '' }
$wins = $AE::RootElement.FindAll($TS::Children, $pidCond)
$main = $wins | Sort-Object { $_.Current.BoundingRectangle.Width * $_.Current.BoundingRectangle.Height } -Descending | Select-Object -First 1
if (-not $main) { 'no window'; exit 1 }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$found = New-Object System.Collections.ArrayList
function Walk($e, $depth) {
  if ($depth -gt 14) { return }
  $c = $walker.GetFirstChild($e)
  while ($c) {
    $k = Kind $c
    if ($k -ne 'Document') {
      if ($k -in 'Button', 'MenuItem', 'SplitButton', 'Edit') { [void]$found.Add($c) }
      Walk $c ($depth + 1)
    }
    $c = $walker.GetNextSibling($c)
  }
}
Walk $main 0
$p = $null
if ($Action -eq 'menu') {
  $btn = $found | Where-Object { $_.Current.ClassName -match 'AppMenuButton' } | Select-Object -First 1
  if (-not $btn) { $btn = $found | Where-Object { (Kind $_) -eq 'Button' -and $_.Current.Name -eq 'Brave' } | Select-Object -Last 1 }
  if (-not $btn) { 'no app menu button'; exit 1 }
  if ($btn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke() }
  elseif ($btn.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand() }
  "menu via $($btn.Current.ClassName)"
} elseif ($Action -eq 'list') {
  $found | ForEach-Object { "$(Kind $_) | $($_.Current.ClassName) | $($_.Current.Name)" }
} elseif ($Action -eq 'press') {
  $btn = $found | Where-Object { ((Kind $_) -in @('Button', 'SplitButton')) -and ($_.Current.Name -match $Text) } | Select-Object -First 1
  if (-not $btn) { "no button matching $Text"; exit 1 }
  if ($btn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke() }
  elseif ($btn.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { try { $p.Expand() } catch { } }
  "pressed '$($btn.Current.Name)' ($($btn.Current.ClassName))"
} else {
  $edit = $found | Where-Object { (Kind $_) -eq 'Edit' } | Select-Object -First 1
  if (-not $edit) { 'no address bar'; exit 1 }
  try { $edit.SetFocus() } catch { "focus: $($_.Exception.Message)" }
  if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $p.SetValue($Text); "omnibox set via $($edit.Current.ClassName)" } else { 'address bar has no value pattern' }
}
