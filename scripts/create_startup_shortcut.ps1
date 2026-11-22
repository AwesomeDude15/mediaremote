# Creates the MediaRemote startup shortcut in the current user's Startup folder
$ErrorActionPreference = "Stop"

$startupDir = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\Startup")
$shortcutPath = Join-Path $startupDir "MediaRemote.lnk"
$targetScript = "c:\Users\rajli\Downloads\mediaremote\mediaremote\agent\run_hidden.vbs"
$workingDir = "c:\Users\rajli\Downloads\mediaremote\mediaremote\agent"

if (-not (Test-Path $targetScript)) {
    throw "Target script not found: $targetScript"
}

$wshShell = New-Object -ComObject WScript.Shell
$shortcut = $wshShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetScript
$shortcut.WorkingDirectory = $workingDir
$shortcut.Description = "MediaRemote silent background host agent"
$shortcut.Save()

Write-Host "Created shortcut: $shortcutPath"
Write-Host "Target: $($shortcut.TargetPath)"
Write-Host "Working Directory: $($shortcut.WorkingDirectory)"
