const fs = require("node:fs")
const path = require("node:path")

// Every run of a Playwright suite writes into a directory of its own,
// test-results/runs/<suite>/<started>-<pid>. Playwright empties its outputDir
// when a run starts, so with one shared directory the next run (a rerun, or
// another session's) deleted the traces, screenshots and logs of the failure
// being investigated. The newest KEEP runs of each suite are kept.

const KEEP = 20
const root = path.resolve(__dirname, "../../../test-results/runs")

/** The run's output directory, the same in the runner and in every worker. */
function runOutputDir(suite) {
  // Each worker evaluates the config again; they inherit this from the runner.
  const key = `ONCE_E2E_RUN_DIR_${suite.toUpperCase().replace(/\W/g, "_")}`
  if (process.env[key]) return process.env[key]
  const directory = path.join(root, suite, `${localStamp()}-${process.pid}`)
  prune(path.join(root, suite))
  process.env[key] = directory
  return directory
}

// Local time, as whoever looks for the run reads their clock: 2026-10-13_16-04-04.
function localStamp(date = new Date()) {
  const two = (value) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}_` +
    `${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}`
}

function prune(suiteDirectory) {
  let runs
  try {
    runs = fs.readdirSync(suiteDirectory, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return
  }
  // Names start with the start time, so they sort oldest first; one slot is for the new run.
  for (const old of runs.map((entry) => entry.name).sort().slice(0, Math.max(0, runs.length - (KEEP - 1)))) {
    fs.rmSync(path.join(suiteDirectory, old), { recursive: true, force: true, maxRetries: 2 })
  }
}

module.exports = { runOutputDir }
