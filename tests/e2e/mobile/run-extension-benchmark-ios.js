// Build/install first with build-extension-benchmark-ios.js and xcodebuild.
const fs = require("node:fs")
const path = require("node:path")
const { randomUUID } = require("node:crypto")
const { execFileSync } = require("node:child_process")
const { setTimeout: delay } = require("node:timers/promises")
const device = process.argv[2]
if (!device) throw new Error("Pass a devicectl device identifier")
const rounds = Number(process.argv[3] || 5)
if (!Number.isInteger(rounds) || rounds < 1) throw new Error("Rounds must be a positive integer")
const output = path.resolve(process.env.ONCE_BENCH_OUTPUT || "artifacts/extension-benchmark-ios-current")
fs.mkdirSync(output, { recursive: true })
const run = args => execFileSync("xcrun", ["devicectl", ...args], { encoding: "utf8", timeout: 60000, stdio: "pipe" })
async function sample(mode, round) {
  const token = randomUUID()
  const target = path.join(output, `ios-${round}-${mode}.json`)
  if (fs.existsSync(target)) throw new Error(`Refusing to overwrite existing evidence: ${target}`)
  const pending = path.join(output, "pending.json")
  run(["device", "process", "launch", "--device", device, "--terminate-existing", "com.zmarn.once.extensionbenchmark", mode, token,
    ...(process.env.ONCE_BENCH_MEMORY === "1" ? ["--memory"] : [])])
  const deadline = Date.now() + 180000
  let data
  while (Date.now() < deadline) {
    await delay(2000)
    try {
      run(["device", "copy", "from", "--device", device, "--domain-type", "appDataContainer", "--domain-identifier", "com.zmarn.once.extensionbenchmark", "--source", "Documents/benchmark.json", "--destination", pending])
      data = JSON.parse(fs.readFileSync(pending, "utf8"))
    } catch { continue }
    if (data.runToken !== token || !data.done) continue
    fs.writeFileSync(target, JSON.stringify({ ...data, round }, null, 2) + "\n")
    if (data.error || data.mode !== mode) throw new Error(`Failed result: ${target}: ${data.error}`)
    if (!["rules", "filter-regression", "install", "export-cache"].includes(mode)) {
      if (data.pages?.length !== 4 || data.pages.some(page => !page.work || page.network?.bytes !== 1638400 || page.unexpectedScript !== false)) throw new Error(`Incomplete result: ${target}`)
      const expected = mode.startsWith("matched") ? Number(mode.replace("matched", "")) : 0
      if (data.pages.some(page => page.matchedScripts !== expected)) throw new Error(`Incorrect content-script execution: ${target}`)
      const dark = mode === "all" || mode === "dark"
      if (data.pages.some(page => (page.work.darkStyles > 0) !== dark)) throw new Error(`Incorrect Dark Reader state: ${target}`)
      if (data.catalog?.some(item => item.disabledReason)) throw new Error(`Extension error: ${target}`)
      if (Object.values(data.contextErrors || {}).some(errors => errors.length)) throw new Error(`Native context error: ${target}`)
      if (mode.startsWith("dnr") && data.pages.some(page => page.dnrProbeBlocked !== (mode !== "dnr0"))) throw new Error(`Inactive DNR rules: ${target}`)
    }
    console.log(JSON.stringify({ round, mode, prepareMs: data.prepareMs, navigationMs: data.pages?.[0].navigationMs, thermal: data.thermalEnd }))
    return
  }
  throw new Error(`Timed out: ${mode}; last result token=${data?.runToken}, error=${data?.error}`)
}
async function main() {
  const modes = (process.env.ONCE_BENCH_MODES || "bare,amo,disabled,blocker,vm,sponsor,dark,all").split(",")
  if (modes.some(mode => !/^(bare|amo|disabled|blocker|vm|sponsor|dark|all|rules|filter-regression|install|export-cache|dnr(?:0|1000|10000|50000)|scripts\d+|installed(?:disabled)?\d+|matched\d+)$/.test(mode))) throw new Error("Unknown mode")
  // Retain conditioning evidence, but do not include it in measured summaries.
  const first = process.env.ONCE_BENCH_WARMUP === "0" ? 0 : -1
  for (let round = first; round < rounds; round++) {
    const offset = (round + modes.length) % modes.length
    const order = [...modes.slice(offset), ...modes.slice(0, offset)]
    if (round % 2) order.reverse()
    for (const mode of order) await sample(mode, round)
  }
  fs.rmSync(path.join(output, "pending.json"), { force: true })
}
main().catch(error => { console.error(error); process.exitCode = 1 })
