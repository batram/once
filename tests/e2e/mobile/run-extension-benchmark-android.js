const fs = require("node:fs")
const path = require("node:path")
const http = require("node:http")
const { execFileSync } = require("node:child_process")
const { setTimeout: delay } = require("node:timers/promises")
const { fixture } = require("./extension-benchmark-fixture")
const serial = process.argv[2]
if (!serial) throw new Error("Pass an adb device serial")
const rounds = Number(process.argv[3] || 4)
const output = path.resolve(process.env.ONCE_BENCH_OUTPUT || "artifacts/extension-benchmark")
fs.mkdirSync(output, { recursive: true })
const pkg = "com.zmarn.once.extensionbenchmark"
const adb = args => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 30000 })
const reports = new Map()
const payload = Buffer.alloc(16384, 65)
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost")
  res.setHeader("Cache-Control", "no-store")
  if (url.pathname === "/payload") { res.end(payload); return }
  if (url.pathname.startsWith("/filters/")) {
    const count = Number(url.pathname.split("/").at(-1))
    res.end(Array.from({ length: count }, (_, i) => `||never-match-${i}.example^`).join("\n")); return
  }
  if (url.pathname === "/report") {
    let text = ""
    req.on("data", chunk => { text += chunk })
    req.on("end", () => {
      const report = JSON.parse(text)
      const pages = reports.get(report.run) || []
      pages.push(report); reports.set(report.run, pages)
      res.end("ok")
    }); return
  }
  if (url.pathname !== "/fixture") { res.writeHead(404); res.end(); return }
  const run = url.searchParams.get("run")
  const page = Number(url.searchParams.get("page"))
  res.setHeader("Content-Type", "text/html")
  res.end(fixture() + `<script>
addEventListener('load', async () => {
 try {
  await new Promise(r => setTimeout(r,1000));
  const work = await benchmark();
  const start = performance.now();
  const responses = await Promise.all(Array.from({length:100},(_,i)=>fetch('/payload?run=${run}&page=${page}&n='+i).then(r=>r.arrayBuffer())));
  const network = {elapsedMs:performance.now()-start,bytes:responses.reduce((n,x)=>n+x.byteLength,0)};
  await fetch('/report',{method:'POST',body:JSON.stringify({run:${JSON.stringify(run)},page:${page},work,network,navigation:performance.getEntriesByType('navigation')[0]?.toJSON()})});
  ${page < 3 ? `location.href='/fixture?run=${run}&page=${page + 1}';` : "document.title='Benchmark complete';"}
 } catch(error) { await fetch('/report',{method:'POST',body:JSON.stringify({run:${JSON.stringify(run)},page:${page},error:String(error)})}); }
});</script>`)
})
async function main() {
  await new Promise(resolve => server.listen(18765, "127.0.0.1", resolve))
  const modes = (process.env.ONCE_BENCH_MODES || "bare,bridge,blocker,vm,all,bridge1000,bridge10000").split(",")
  for (let round = 0; round < rounds; round++) {
    const order = [...modes.slice(round % modes.length), ...modes.slice(0, round % modes.length)]
    if (round % 2) order.reverse()
    for (const mode of order) {
      const run = `android-${round}-${mode}`
      adb(["shell", "am", "force-stop", pkg])
      adb(["shell", "am", "start", "-n", `${pkg}/com.zmarn.once.ExtensionBenchmarkActivity`, "--es", "mode", mode, "--es", "run", run, "--es", "fixtureBase", process.env.ONCE_BENCH_BASE || "http://10.0.2.2:18765"])
      for (let attempt = 0; attempt < 90 && reports.get(run)?.length !== 4; attempt++) await delay(1000)
      const native = JSON.parse(adb(["shell", "run-as", pkg, "cat", "files/benchmark.json"]))
      const pages = reports.get(run)
      if (native.error || pages?.length !== 4 || pages.some(page => page.error)) throw new Error(`Incomplete ${run}: ${JSON.stringify(native)}`)
      const processes = adb(["shell", "ps", "-A", "-o", "PID,NAME"]).split("\n")
        .map(line => line.trim().split(/\s+/)).filter(([, name]) => name === pkg || name?.startsWith(pkg + ":"))
      const memory = processes.map(([pid]) => adb(["shell", "dumpsys", "meminfo", pid])).join("\n")
      fs.writeFileSync(path.join(output, `${run}-memory.txt`), memory)
      const data = { ...native, round, fixturePages: pages, processes,
        totalPssKiB: [...memory.matchAll(/TOTAL PSS:\s+(\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0) }
      fs.writeFileSync(path.join(output, `${run}.json`), JSON.stringify(data, null, 2) + "\n")
      console.log(JSON.stringify({ run, readyMs: native.readyMs, networkMs: pages.map(x => x.network.elapsedMs) }))
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => server.close())
