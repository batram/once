// Build/install first with build-extension-benchmark-ios.js and xcodebuild.
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { setTimeout: delay } = require("node:timers/promises")
const device = process.argv[2]
if (!device) throw new Error("Pass a devicectl device identifier")
const rounds = Number(process.argv[3] || 4)
const output = path.resolve(process.env.ONCE_BENCH_OUTPUT || "artifacts/extension-benchmark")
fs.mkdirSync(output, { recursive: true })
const run = args => execFileSync("xcrun", ["devicectl", ...args], { encoding: "utf8", timeout: 60000, stdio: "pipe" })
async function main() {
  const modes = (process.env.ONCE_BENCH_MODES || "bare,disabled,blocker,vm,sponsor,dark,all").split(",")
  for (let round = 0; round < rounds; round++) {
    // Rotate and reverse to reduce a systematic order/temperature bias.
    const order = [...modes.slice(round % modes.length), ...modes.slice(0, round % modes.length)]
    if (round % 2) order.reverse()
    for (const mode of order) {
      const target = path.join(output, `ios-${round}-${mode}.json`)
      run(["device", "process", "launch", "--device", device, "--terminate-existing", "com.zmarn.once.extensionbenchmark", mode])
      await delay(14000)
      run(["device", "copy", "from", "--device", device, "--domain-type", "appDataContainer", "--domain-identifier", "com.zmarn.once.extensionbenchmark", "--source", "Documents/benchmark.json", "--destination", target])
      const data = JSON.parse(fs.readFileSync(target, "utf8"))
      if (!data.done || data.error || data.mode !== mode || data.pages?.length !== 4) throw new Error(`Invalid result: ${target}`)
      if (data.catalog?.some(item => item.disabledReason)) throw new Error(`Extension error: ${target}`)
      console.log(JSON.stringify({ round, mode, prepareMs: data.prepareMs, navigationMs: data.pages[0].navigationMs, thermal: data.thermalEnd }))
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
