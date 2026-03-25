$desktop = [Environment]::GetFolderPath("Desktop")
$target = "C:\Users\shibe\VisionLandingConsole\start-vision-landing-console.bat"
$icon = "$env:SystemRoot\System32\shell32.dll"
$shortcutPath = Join-Path $desktop "Vision Landing Console.lnk"

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = "C:\Users\shibe\VisionLandingConsole"
$shortcut.IconLocation = "$icon,41"
$shortcut.Description = "Launch Vision Landing Console"
$shortcut.Save()

Write-Host "Shortcut created at: $shortcutPath"
