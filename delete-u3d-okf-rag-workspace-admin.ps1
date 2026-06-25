$ErrorActionPreference = "Stop"

$Target = "F:\workspace\main\Unicorn\u3dclient\okf-rag-workspace"
$ExpectedParent = "F:\workspace\main\Unicorn\u3dclient"

$resolvedParent = [System.IO.Path]::GetFullPath($ExpectedParent)
$resolvedTarget = [System.IO.Path]::GetFullPath($Target)
$longTarget = "\\?\$resolvedTarget"

if (-not $resolvedTarget.StartsWith($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to delete outside expected parent: $resolvedTarget"
}

if ((Split-Path -Leaf $resolvedTarget) -ne "okf-rag-workspace") {
  throw "Refusing to delete unexpected folder: $resolvedTarget"
}

if (-not (Test-Path -LiteralPath $resolvedTarget)) {
  Write-Host "Not found: $resolvedTarget"
  exit 0
}

$currentUser = "$env:USERDOMAIN\$env:USERNAME"
$administrators = "BUILTIN\Administrators"

Write-Host "Clearing readonly/system/hidden attributes: $resolvedTarget"
cmd.exe /c "attrib -R -S -H `"$resolvedTarget\*`" /S /D"
cmd.exe /c "attrib -R -S -H `"$longTarget\*`" /S /D"

Write-Host "Taking ownership as Administrators: $resolvedTarget"
cmd.exe /c "takeown /A /F `"$resolvedTarget`" /R /D Y"

Write-Host "Forcing owner on tree: $resolvedTarget"
cmd.exe /c "icacls `"$resolvedTarget`" /setowner `"$administrators`" /T /C /Q"

Write-Host "Resetting ACL inheritance on tree: $resolvedTarget"
cmd.exe /c "icacls `"$resolvedTarget`" /inheritance:e /T /C /Q"
cmd.exe /c "icacls `"$resolvedTarget`" /reset /T /C /Q"

Write-Host "Granting full control to Administrators and current user"
cmd.exe /c "icacls `"$resolvedTarget`" /grant `"$administrators`":(OI)(CI)F /T /C /Q"
cmd.exe /c "icacls `"$resolvedTarget`" /grant `"${currentUser}`":(OI)(CI)F /T /C /Q"

Write-Host "Deleting with cmd rd: $resolvedTarget"
cmd.exe /c "rd /s /q `"$resolvedTarget`""
cmd.exe /c "rd /s /q `"$longTarget`""

if (Test-Path -LiteralPath $resolvedTarget) {
  Write-Host "cmd rd did not finish; deleting with PowerShell Remove-Item"
  try {
    Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
  } catch {
    Write-Host "PowerShell delete failed: $($_.Exception.Message)"
  }
}

if (Test-Path -LiteralPath $resolvedTarget) {
  Write-Host "Trying robocopy empty-directory mirror"
  $empty = Join-Path $env:TEMP "empty-okf-rag-delete-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $empty -Force | Out-Null
  robocopy.exe $empty $resolvedTarget /MIR /R:0 /W:0 /NFL /NDL /NJH /NJS /NC /NS /NP | Write-Host
  Remove-Item -LiteralPath $empty -Recurse -Force
  cmd.exe /c "rd /s /q `"$resolvedTarget`""
}

if (Test-Path -LiteralPath $resolvedTarget) {
  Write-Host "Admin delete did not finish; trying one-time SYSTEM scheduled task"
  $taskName = "okf-rag-delete-$([guid]::NewGuid().ToString('N'))"
  $helper = Join-Path $env:TEMP "$taskName.ps1"
  $helperLog = Join-Path $env:TEMP "$taskName.log"
  $helperContent = @"
`$ErrorActionPreference = "Continue"
`$Target = "$resolvedTarget"
`$LongTarget = "\\?\$resolvedTarget"
`$Log = "$helperLog"
"SYSTEM delete started: `$Target" | Out-File -FilePath `$Log -Encoding UTF8
cmd.exe /c "attrib -R -S -H ```"`$Target\*```" /S /D" 2>&1 | Out-File -FilePath `$Log -Append -Encoding UTF8
cmd.exe /c "attrib -R -S -H ```"`$LongTarget\*```" /S /D" 2>&1 | Out-File -FilePath `$Log -Append -Encoding UTF8
cmd.exe /c "takeown /A /F ```"`$Target```" /R /D Y" 2>&1 | Out-File -FilePath `$Log -Append -Encoding UTF8
cmd.exe /c "takeown /A /F ```"`$LongTarget```" /R /D Y" 2>&1 | Out-File -FilePath `$Log -Append -Encoding UTF8
cmd.exe /c "icacls ```"`$Target```" /setowner ```"BUILTIN\Administrators```" /T /C /Q" 2>&1 | Out-File -FilePath `$Log -Append -Encoding UTF8
cmd.exe /c "icacls ```"`$Target```" /reset /T /C /Q" 2>&1 | Out-File -FilePath `$Log -Append -Encoding UTF8
cmd.exe /c "icacls ```"`$Target```" /grant ```"SYSTEM```":(OI)(CI)F /T /C /Q" 2>&1 | Out-File -FilePath `$Log -Append -Encoding UTF8
cmd.exe /c "icacls ```"`$Target```" /grant ```"BUILTIN\Administrators```":(OI)(CI)F /T /C /Q" 2>&1 | Out-File -FilePath `$Log -Append -Encoding UTF8
cmd.exe /c "rd /s /q ```"`$Target```"" 2>&1 | Out-File -FilePath `$Log -Append -Encoding UTF8
cmd.exe /c "rd /s /q ```"`$LongTarget```"" 2>&1 | Out-File -FilePath `$Log -Append -Encoding UTF8
if (Test-Path -LiteralPath `$Target) {
  `$Empty = Join-Path `$env:TEMP "empty-okf-rag-system-delete"
  New-Item -ItemType Directory -Path `$Empty -Force | Out-Null
  robocopy.exe `$Empty `$Target /MIR /R:0 /W:0 /NFL /NDL /NJH /NJS /NC /NS /NP 2>&1 | Out-File -FilePath `$Log -Append -Encoding UTF8
  Remove-Item -LiteralPath `$Empty -Recurse -Force
  cmd.exe /c "rd /s /q ```"`$Target```"" 2>&1 | Out-File -FilePath `$Log -Append -Encoding UTF8
}
if (Test-Path -LiteralPath `$Target) {
  "SYSTEM delete failed: still exists" | Out-File -FilePath `$Log -Append -Encoding UTF8
  exit 1
}
"SYSTEM delete succeeded" | Out-File -FilePath `$Log -Append -Encoding UTF8
exit 0
"@
  Set-Content -LiteralPath $helper -Value $helperContent -Encoding UTF8

  $startTime = (Get-Date).AddMinutes(1).ToString("HH:mm")
  schtasks.exe /Create /TN $taskName /SC ONCE /ST $startTime /RU SYSTEM /RL HIGHEST /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$helper`"" /F | Write-Host
  schtasks.exe /Run /TN $taskName | Write-Host

  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Test-Path -LiteralPath $resolvedTarget)) {
      break
    }
  }

  schtasks.exe /Delete /TN $taskName /F | Write-Host

  if (Test-Path -LiteralPath $helperLog) {
    Write-Host "SYSTEM task log:"
    Get-Content -LiteralPath $helperLog | Write-Host
  }
}

if (Test-Path -LiteralPath $resolvedTarget) {
  throw "Delete failed: $resolvedTarget. The remaining files likely have corrupt security descriptors. Run: chkdsk F: /f"
}

Write-Host "Deleted: $resolvedTarget"
