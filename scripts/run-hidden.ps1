param([Parameter(Mandatory)][string]$Manifest, [switch]$Child)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$command = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
Set-Location -LiteralPath $command.cwd
if ($Child) {
    # Node redirects both streams directly; PowerShell otherwise turns native
    # stderr warnings into error records and can abort an otherwise healthy run.
    & $command.executable $command.runner '--child' $Manifest
    exit $LASTEXITCODE
}
$wrapper = Join-Path $env:USERPROFILE 'tools/agent-scripts/Invoke-OnHiddenDesktop.ps1'
if (-not (Test-Path -LiteralPath $wrapper)) {
    throw "Hidden desktop launcher not found: $wrapper. Install it before running unattended GUI tests."
}
# run-hidden.js shows the log as it grows.
$testExitCode = & $wrapper -FilePath (Get-Command powershell.exe).Source -ArgumentList '-NoProfile','-File',$PSCommandPath,'-Manifest',$Manifest,'-Child' -WorkingDirectory $command.cwd -TimeoutSeconds 3600
exit $testExitCode
