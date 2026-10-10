// Inspect the Once app running on a USB-connected iPhone from the command
// line: run JavaScript in it, follow its console, read its captured logs.
// Talks to WebKit's remote inspector through pymobiledevice3's CDP bridge,
// which needs no Safari, tunnel or sudo. Release builds are only listed while
// Settings -> Error log -> Show console messages -> Allow Web Inspector is on.
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const USAGE = `Usage: node scripts/ios-inspect.js <command> [options]

Commands:
  targets                 List inspectable pages on the phone
  eval <expression>       Evaluate an expression (awaited if it is a promise) and print the result as JSON
  console                 Print console messages as they happen (Ctrl-C to stop)
  log                     Print the console messages and error log entries the app kept
  stop                    Stop the bridge this script started

Options:
  --target <title>        Page title to use, e.g. "Once" or "Once Dev" (default: the only Once page, else "Once")
  --seconds <n>           For console: stop after n seconds
  --levels <list>         For console: only these types, e.g. error,warning (log, info, debug, ...)
  --history               For console: also print the messages logged before it attached
  --eval <expression>     For console: evaluate this once attached, e.g. "location.reload()"

The bridge serves one connection per page: starting another command takes the
page over from a running console, which then exits. Use console --eval to
trigger something and watch its output in one connection.
  --port <n>              Bridge port (default 9222)

The bridge is pymobiledevice3 (\`webinspector cdp\`). It is looked up in
$PYMOBILEDEVICE3, then ~/.local/share/pymobiledevice3/bin, then PATH; it keeps
running between calls so later commands start instantly.`

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  if (index < 0) return fallback
  const [, value] = args.splice(index, 2)
  return value
}
const port = Number(option("port", "9222"))
const wanted = option("target", undefined)
const seconds = Number(option("seconds", "0"))
const levels = option("levels", undefined)?.split(",")
const trigger = option("eval", undefined)
const historyIndex = args.indexOf("--history")
const history = historyIndex >= 0 && Boolean(args.splice(historyIndex, 1))
const [command, ...rest] = args
const base = `http://127.0.0.1:${port}`
const pidFile = path.join(os.tmpdir(), `once-ios-inspect-${port}.pid`)

function fail(message) {
  console.error(message)
  process.exit(1)
}

function truncate(text, limit = 2000) {
  return typeof text === "string" && text.length > limit ? `${text.slice(0, limit)}… (${text.length} characters)` : text
}

function bridgeExecutable() {
  const candidates = [
    process.env.PYMOBILEDEVICE3,
    path.join(os.homedir(), ".local/share/pymobiledevice3/bin/pymobiledevice3")
  ].filter(Boolean)
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "pymobiledevice3"
}

async function listTargets() {
  try {
    const response = await fetch(`${base}/json`, { signal: AbortSignal.timeout(3000) })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

async function ensureBridge() {
  const ready = await listTargets()
  if (ready) return ready
  const bridge = spawn(bridgeExecutable(), ["webinspector", "cdp", "--port", String(port)], {
    detached: true,
    stdio: "ignore"
  })
  bridge.on("error", (error) => fail(`Could not start pymobiledevice3 (${error.message}); install it as described in docs/DEVELOPMENT.md ("Debug a running release build").`))
  bridge.unref()
  fs.writeFileSync(pidFile, String(bridge.pid))
  // A new bridge answers before it has found the phone's pages.
  let targets = null
  for (let attempt = 0; attempt < 60 && !targets?.length; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    targets = await listTargets() ?? targets
    if (targets && attempt >= 20) break
  }
  if (targets) return targets
  fail("The bridge did not start. Is the iPhone connected, unlocked and trusting this Mac?")
}

function pickTarget(targets) {
  const pages = targets.filter((target) => target.type === "page")
  const once = pages.filter((target) => /^Once\b/.test(target.title))
  const target = wanted
    ? pages.find((page) => page.title === wanted)
    : once.length === 1 ? once[0] : once.find((page) => page.title === "Once")
  if (target) return target
  const listed = pages.map((page) => `  ${page.title}  ${page.url}`).join("\n") || "  (none)"
  fail(`No ${wanted ? `"${wanted}"` : "Once"} page to inspect. Inspectable pages:\n${listed}\n` +
    "A release build is listed only while its Allow Web Inspector switch is on.")
}

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  const listeners = []
  let nextId = 0
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) pending.get(message.id)?.(message)
    else listeners.forEach((listener) => listener(message))
  }
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error(`Could not connect to ${target.title}`))
  })
  // A suspended app (in the background, or the phone locked) never answers.
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => reject(new Error(
      `${target.title} did not answer ${method}; bring the app to the foreground and keep the phone unlocked.`
    )), 10000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      pending.delete(id)
      if (message.error) reject(new Error(`${method}: ${message.error.message}`))
      else resolve(message.result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { send, onEvent: (listener) => listeners.push(listener), close: () => socket.close() }
}

// The bridge ignores awaitPromise, so the page settles the value into a
// global and this side polls for it.
async function evaluate(session, expression) {
  const key = `__onceInspect${Date.now()}`
  const start = await session.send("Runtime.evaluate", {
    expression: `(() => {
      const settle = (state) => { globalThis[${JSON.stringify(key)}] = state }
      // WebKit stacks leave out the message.
      const describe = (error) => error instanceof Error ? error.name + ": " + error.message + "\\n" + (error.stack ?? "") : String(error)
      try {
        Promise.resolve((${expression}))
          .then((value) => settle({ ok: true, value }), (error) => settle({ ok: false, value: describe(error) }))
      } catch (error) { settle({ ok: false, value: describe(error) }) }
    })()`
  })
  if (start.wasThrown) throw new Error(start.result?.description ?? "The expression does not parse")
  for (let attempt = 0; attempt < 300; attempt++) {
    const { result } = await session.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const state = globalThis[${JSON.stringify(key)}]
        if (!state) return null
        delete globalThis[${JSON.stringify(key)}]
        try { return JSON.stringify(state) } catch { return JSON.stringify({ ok: state.ok, value: String(state.value) }) }
      })()`
    })
    if (result.value) return JSON.parse(result.value)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("The expression did not settle within 30 seconds")
}

// Objects arrive as references; the page serializes them, errors keep their stack.
async function describeArgument(session, argument) {
  if ("value" in argument) return typeof argument.value === "string" ? argument.value : JSON.stringify(argument.value)
  if (!argument.objectId || /Error$/.test(argument.className ?? "")) return argument.description ?? argument.type
  try {
    const { result } = await session.send("Runtime.callFunctionOn", {
      objectId: argument.objectId,
      returnByValue: true,
      functionDeclaration: "function () { try { return JSON.stringify(this) } catch { return String(this) } }"
    })
    return truncate(result.value ?? argument.description)
  } catch {
    return argument.description ?? argument.type
  }
}

async function main() {
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE)
    return
  }
  if (command === "stop") {
    if (!fs.existsSync(pidFile)) return console.log("No bridge started by this script.")
    try { process.kill(Number(fs.readFileSync(pidFile, "utf8"))) } catch { /* already gone */ }
    fs.rmSync(pidFile)
    return console.log("Bridge stopped.")
  }
  const targets = await ensureBridge()
  if (command === "targets") {
    for (const target of targets) console.log(`${target.title}\t${target.url}\t${target.id}`)
    if (!targets.length) console.log("No inspectable pages.")
    return
  }
  const session = await connect(pickTarget(targets))
  try {
    if (command === "eval") {
      if (!rest.length) fail("eval needs an expression")
      const { ok, value } = await evaluate(session, rest.join(" "))
      console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2))
      if (!ok) process.exitCode = 1
    } else if (command === "log") {
      const { value } = await evaluate(session, `({
        console: JSON.parse(localStorage.getItem("once:console-log") || "[]"),
        errors: [...document.querySelectorAll("#error_log .error_log_entry")]
          .map((entry) => entry.querySelector("summary")?.textContent + "\\n" + (entry.querySelector("pre")?.textContent ?? ""))
      })`)
      console.log("Console messages:")
      for (const entry of value.console) console.log(`${new Date(entry.time).toISOString()} [${entry.level}] ${entry.text}`)
      console.log("\nError log:")
      for (const entry of value.errors) console.log(`${entry}\n`)
    } else if (command === "console") {
      // Enabling the console replays every earlier message first.
      let live = history
      let printing = Promise.resolve()
      session.onEvent((message) => {
        if (message.method !== "Runtime.consoleAPICalled" || !live) return
        const { type, args: values, timestamp } = message.params
        if (levels && !levels.includes(type)) return
        const described = Promise.all(values.map((value) => describeArgument(session, value)))
        printing = printing.then(async () => {
          console.log(`${new Date(timestamp).toISOString()} [${type}] ${(await described).join(" ")}`)
        })
      })
      await session.send("Runtime.enable")
      // The bridge forwards console messages only once Console is enabled.
      await session.send("Console.enable")
      live = true
      if (trigger) {
        const { ok, value } = await evaluate(session, trigger)
        if (!ok) console.error(value)
      }
      let check
      await new Promise((resolve, reject) => {
        process.on("SIGINT", resolve)
        if (seconds > 0) setTimeout(resolve, seconds * 1000)
        // A taken-over connection gets no more events or replies.
        check = setInterval(() => {
          session.send("Runtime.evaluate", { expression: "0" })
            .catch(() => reject(new Error("Lost the page: another inspector connected, or the app was suspended.")))
        }, 5000)
      }).finally(() => clearInterval(check))
      await printing
    } else {
      fail(USAGE)
    }
  } finally {
    session.close()
  }
}

main().catch((error) => fail(error.message))
