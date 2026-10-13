// Writes run.log into the run's output directory (see run-output.js) as the
// run goes: how it was started, each test's start and result with its errors
// and attachments, everything the tests printed, and a summary. Appended line
// by line, so a run that is killed or hangs still leaves what it got through.
const fs = require("node:fs")
const path = require("node:path")
const { stripVTControlCharacters } = require("node:util")

const root = path.resolve(__dirname, "../../..")

class RunLog {
  onBegin(config, suite) {
    this.directory = config.projects[0]?.outputDir ?? path.join(root, "test-results")
    fs.mkdirSync(this.directory, { recursive: true })
    this.file = path.join(this.directory, "run.log")
    this.started = Date.now()
    this.write(
      `Run started ${new Date().toString()}\n` +
      `Command: ${process.argv.slice(1).join(" ")}\n` +
      `Config: ${path.relative(root, config.configFile ?? "")}\n` +
      `Hidden desktop: ${process.env.ONCE_HIDDEN_DESKTOP === "1" ? "yes" : "no"}, CI: ${process.env.CI ? "yes" : "no"}\n` +
      `Tests: ${suite.allTests().length}, workers: ${config.workers}\n`
    )
    console.log(`Run output and log: ${path.relative(root, this.directory)}`)
  }

  onTestBegin(test, result) {
    this.write(`\n[${this.elapsed()}] START ${this.name(test)}${result.retry ? ` (retry ${result.retry})` : ""}`)
  }

  onStdOut(chunk, test) {
    this.output(chunk, test)
  }

  onStdErr(chunk, test) {
    this.output(chunk, test)
  }

  onTestEnd(test, result) {
    const status = result.status === test.expectedStatus ? "PASS" : result.status.toUpperCase()
    this.write(`[${this.elapsed()}] ${status} ${this.name(test)} (${result.duration} ms)`)
    for (const error of result.errors) {
      this.write(indent(stripVTControlCharacters(error.stack ?? error.message ?? String(error.value))))
    }
    for (const attachment of result.attachments) {
      if (attachment.path) this.write(`  attachment ${attachment.name}: ${path.relative(root, attachment.path)}`)
    }
  }

  onError(error) {
    this.write(`\n[${this.elapsed()}] ERROR outside a test\n${indent(stripVTControlCharacters(error.stack ?? error.message ?? ""))}`)
  }

  onEnd(result) {
    this.write(`\nRun ${result.status} after ${Math.round((Date.now() - this.started) / 1000)} s`)
    console.log(`Run log: ${path.relative(root, this.file)}`)
  }

  printsToStdio() {
    return false
  }

  output(chunk, test) {
    const text = stripVTControlCharacters(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)).replace(/\n$/, "")
    if (text) this.write(indent(text, test ? "  | " : "  (runner) "))
  }

  name(test) {
    return `${path.relative(root, test.location.file)}:${test.location.line} › ${test.titlePath().slice(3).join(" › ")}`
  }

  elapsed() {
    return `${((Date.now() - this.started) / 1000).toFixed(1)}s`
  }

  write(text) {
    fs.appendFileSync(this.file, `${text}\n`)
  }
}

function indent(text, prefix = "    ") {
  return text.split("\n").map((line) => prefix + line).join("\n")
}

module.exports = RunLog
