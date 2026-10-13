const { format, stripVTControlCharacters } = require("node:util")

// Chrome's own process log: its launch and pid, what it writes to stderr,
// when Playwright starts closing it, and how the process exited. Playwright
// reports these on its `pw:browser` debug channel only, never to the client
// API (a launch `logger` receives API calls alone), so a test that needs to
// know why its browser went away taps that channel here. It is the debug
// module Playwright's in-process server writes through, a declared export of
// playwright-core; output the user asked for with DEBUG still reaches stderr.

const listeners = new Set()
let available = null

function install() {
  if (available !== null) return available
  try {
    const { debug } = require("playwright-core/lib/utilsBundle")
    const requested = process.env.DEBUG || ""
    debug.enable(requested)
    const userWantsBrowser = debug.enabled("pw:browser")
    debug.enable([requested, "pw:browser"].filter(Boolean).join(","))
    const write = debug.log ?? ((...args) => process.stderr.write(`${format(...args)}\n`))
    debug.log = function (...args) {
      const text = stripVTControlCharacters(format(...args))
      const browser = text.match(/pw:browser\s+([\s\S]*?)(?:\s+\+\d+(?:ms|s|m|h|d))?\s*$/)
      if (!browser) return write.apply(this, args)
      for (const listener of listeners) listener(browser[1])
      if (userWantsBrowser) write.apply(this, args)
    }
    available = true
  } catch {
    available = false
  }
  return available
}

/**
 * Follows the next Chrome this process launches: call before launching it.
 * `onLine` gets each of its log lines; the result says what is known so far.
 */
function followChromeProcess(onLine) {
  const state = { available: install(), pid: null, closeRequestedByPlaywright: false, exit: null }
  const waiters = new Set()
  const listener = (line) => {
    const launched = line.match(/^<launched> pid=(\d+)/)
    if (launched && state.pid === null) state.pid = launched[1]
    const own = line.match(/^\[pid=(\d+)\]/)
    if (own && own[1] !== state.pid) return
    if (!own && !launched && !line.startsWith("<launching>")) return
    if (line.includes("<gracefully close start>")) state.closeRequestedByPlaywright = true
    const exit = line.match(/<process did exit: exitCode=([^,]+), signal=([^>]+)>/)
    if (exit) {
      state.exit = { code: exit[1], signal: exit[2], requested: state.closeRequestedByPlaywright }
      for (const resolve of waiters) resolve()
    }
    onLine(line)
  }
  listeners.add(listener)
  return {
    state,
    /** Resolves once the process exit is logged, or after `timeout` ms. */
    exited(timeout) {
      if (state.exit || !state.available) return Promise.resolve()
      return new Promise((resolve) => {
        const timer = setTimeout(done, timeout)
        function done() { clearTimeout(timer); waiters.delete(done); resolve() }
        waiters.add(done)
      })
    },
    stop() { listeners.delete(listener) }
  }
}

module.exports = { followChromeProcess }
