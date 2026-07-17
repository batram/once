const { spawnSync } = require("child_process")
const path = require("path")

const POWERSHELL_COMMAND = String.raw`
$ErrorActionPreference = "Stop"
$outputRoot = [IO.Path]::GetFullPath($env:ONCE_ELECTRON_OUTPUT_ROOT).TrimEnd("\") + "\"
$processes = Get-Process -Name $env:ONCE_ELECTRON_PROCESS_NAME -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Path -and
    [IO.Path]::GetFullPath($_.Path).StartsWith(
      $outputRoot,
      [StringComparison]::OrdinalIgnoreCase
    )
  }

foreach ($process in $processes) {
  try {
    Stop-Process -Id $process.Id -Force -ErrorAction Stop
    Write-Output $process.Id
  } catch {
    # Stopping one Electron process can make its child processes exit before
    # this snapshot reaches them. Other errors, such as access denied, must
    # still fail the build because the output directory may remain locked.
    if ($_.CategoryInfo.Category -ne [Management.Automation.ErrorCategory]::ObjectNotFound) {
      throw
    }
  }
}

# Get-Process sets PowerShell's success flag to false if the image name was
# absent, even with errors silenced. At this point all actionable errors have
# already been rethrown, so explicitly report success.
exit 0
`

function shouldSkipPackagedAppStop(args, environment) {
  return args.includes("--nokill") || environment.npm_config_nokill === "true"
}

function shouldStopPackagedApp(platform, forgeCommand, skipStop = false) {
  return platform === "win32" &&
    ["package", "make"].includes(forgeCommand) &&
    !skipStop
}

function packagedAppTarget(electronOutputRoot, buildChannel) {
  const isDevChannel = buildChannel === "dev"
  return {
    outputRoot: path.resolve(electronOutputRoot, isDevChannel ? "dev" : ""),
    processName: isDevChannel ? "once-dev" : "once"
  }
}

function stopPackagedApp(outputRoot, processName) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_COMMAND],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ONCE_ELECTRON_OUTPUT_ROOT: path.resolve(outputRoot),
        ONCE_ELECTRON_PROCESS_NAME: processName
      }
    }
  )

  if (result.error) throw result.error
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout]
      .map((output) => output.trim())
      .filter(Boolean)
      .join("\n")
    throw new Error(
      "Could not stop the packaged Once app before building " +
      `(PowerShell exit ${result.status}${result.signal ? `, signal ${result.signal}` : ""})` +
      `${details ? `: ${details}` : "."}`
    )
  }

  const stoppedProcessIds = result.stdout.trim().split(/\s+/).filter(Boolean)
  if (stoppedProcessIds.length > 0) {
    console.log(
      `Stopped packaged Once app process${stoppedProcessIds.length === 1 ? "" : "es"} ` +
      `(${stoppedProcessIds.join(", ")}) before building.`
    )
  }
}

module.exports = {
  packagedAppTarget,
  shouldSkipPackagedAppStop,
  shouldStopPackagedApp,
  stopPackagedApp
}
