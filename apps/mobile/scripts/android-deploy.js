const { spawnSync } = require("node:child_process")

const supportedAbis = ["arm64-v8a", "x86_64"]

function deploymentSettings(env) {
  const abis = env.ONCE_ANDROID_DEPLOY_ABIS || "auto"
  const installMode = env.ONCE_ANDROID_INSTALL_MODE || "push"
  const daemon = env.ONCE_ANDROID_GRADLE_DAEMON || "true"
  if (abis !== "auto" && abis !== "all" &&
      !abis.split(",").every(abi => supportedAbis.includes(abi))) {
    throw new Error("ONCE_ANDROID_DEPLOY_ABIS must be auto, all, or a comma-separated list of arm64-v8a,x86_64")
  }
  if (!["push", "streaming", "fastdeploy"].includes(installMode)) {
    throw new Error("ONCE_ANDROID_INSTALL_MODE must be push, streaming, or fastdeploy")
  }
  if (!["true", "false"].includes(daemon)) {
    throw new Error("ONCE_ANDROID_GRADLE_DAEMON must be true or false")
  }
  return { abis, installMode, daemon: daemon === "true" }
}

function selectDeploymentAbis(setting, deviceAbis) {
  const available = deviceAbis.trim().split(",")
  const selected = setting === "all" ? supportedAbis
    : setting === "auto" ? available.filter(abi => supportedAbis.includes(abi)).slice(0, 1)
      : [...new Set(setting.split(","))]
  if (!selected.some(abi => available.includes(abi))) {
    throw new Error(`deployment ABIs do not support this device (${deviceAbis.trim() || "no ABIs reported"})`)
  }
  return selected
}

function installApk(adb, serial, apk, mode, env, execute = spawnSync) {
  const started = performance.now()
  for (const attempt of mode === "fastdeploy" ? ["fastdeploy", "push"] : [mode]) {
    const flags = attempt === "fastdeploy" ? ["--streaming", "--fastdeploy"]
      : attempt === "streaming" ? ["--streaming"] : ["--no-streaming"]
    console.log(`mobile: installing via ${attempt}`)
    const result = execute(adb, ["-s", serial, "install", "-r", ...flags, apk], {
      env, stdio: "inherit", shell: false
    })
    if (result.error) throw result.error
    if (result.status === 0) {
      console.log(`mobile: install completed in ${((performance.now() - started) / 1000).toFixed(1)}s (requested ${attempt})`)
      return
    }
    if (attempt !== "fastdeploy") throw new Error(`ADB ${attempt} install failed (${result.signal || result.status})`)
    console.warn("mobile: fastdeploy failed; retrying with a full compressed push install")
  }
}

module.exports = { deploymentSettings, selectDeploymentAbis, installApk }
