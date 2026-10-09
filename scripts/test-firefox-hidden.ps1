param([switch]$Child)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $repoRoot
$logDirectory = Join-Path $repoRoot 'test-results/firefox-logs'
$runLog = Join-Path $logDirectory 'hidden-desktop.log'

if ($Child) {
    & node --test --test-concurrency=1 tests/e2e/extensions/firefox.test.js tests/e2e/extensions/firefox-stories.test.js tests/e2e/extensions/firefox-addons.test.js tests/e2e/extensions/geny-firefox.test.js *> $runLog
    exit $LASTEXITCODE
}

$wrapper = Join-Path $env:USERPROFILE 'tools/agent-scripts/Invoke-OnHiddenDesktop.ps1'
if (-not (Test-Path -LiteralPath $wrapper)) {
    throw "Hidden desktop launcher not found: $wrapper. Install it before running Firefox tests on Windows."
}
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
Write-Host "Running Firefox on the hidden desktop; output: $runLog"
$testExitCode = & $wrapper -FilePath (Get-Command powershell.exe).Source -ArgumentList '-NoProfile','-File',$PSCommandPath,'-Child' -WorkingDirectory $repoRoot -TimeoutSeconds 600
if (Test-Path -LiteralPath $runLog) { Get-Content -LiteralPath $runLog }
exit $testExitCode
