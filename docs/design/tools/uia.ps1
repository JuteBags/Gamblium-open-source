# Reads Brave's own interface (not the page) through UI Automation: lists the
# toolbar controls, then opens the app menu and lists its items. No focus needed.
param([Parameter(Mandatory)][int]$ProcessId, [string]$Open = '^Brave$')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$pidCond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $ProcessId)
function Kind($e) { $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', '' }

$wins = $AE::RootElement.FindAll($TS::Children, $pidCond)
$main = $wins | Sort-Object { $_.Current.BoundingRectangle.Width * $_.Current.BoundingRectangle.Height } -Descending | Select-Object -First 1
if (-not $main) { 'no window'; exit 1 }
"WINDOW: $($main.Current.Name)"

# Everything that is not web content: stop descending at the Document.
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$found = New-Object System.Collections.ArrayList
function Walk($e, $depth) {
  if ($depth -gt 14) { return }
  $c = $walker.GetFirstChild($e)
  while ($c) {
    $k = Kind $c
    if ($k -ne 'Document') {
      if ($c.Current.Name -and $k -in 'Button', 'MenuItem', 'SplitButton', 'TabItem', 'Edit', 'CheckBox', 'Hyperlink', 'Text') { [void]$found.Add($c) }
      Walk $c ($depth + 1)
    }
    $c = $walker.GetNextSibling($c)
  }
}
Walk $main 0
'TOOLBAR:'
$found | ForEach-Object { "  [$(Kind $_)] $($_.Current.Name)" }

$btn = $found | Where-Object { $_.Current.Name -match $Open } | Select-Object -First 1
if (-not $btn) { "no control matching '$Open'"; exit 0 }
$p = $null
if ($btn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke() }
elseif ($btn.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand() }
else { 'cannot open it'; exit 0 }
Start-Sleep -Milliseconds 1500
'MENU:'
$itemCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::MenuItem)
foreach ($w in $AE::RootElement.FindAll($TS::Children, $pidCond)) {
  if ((Kind $w) -notin 'Menu', 'Pane', 'Window') { continue }
  foreach ($i in $w.FindAll($TS::Descendants, $itemCond)) { if ($i.Current.Name -notmatch $Open) { "  $($i.Current.Name)" } }
}
