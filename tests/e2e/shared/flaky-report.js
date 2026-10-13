// Reports every test that failed once and passed on its retry as a GitHub
// warning annotation and a job-summary line. A flaky test no longer fails the
// run — the retry already gave it a second sample — but it stays visible on
// the run page instead of disappearing behind a green check. Tests that failed
// outright get an error annotation the same way.
const fs = require("node:fs")
const path = require("node:path")
const { stripVTControlCharacters } = require("node:util")

const root = path.resolve(__dirname, "../../..")
const escapeData = text => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
const escapeProperty = text => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C")

class FlakyReport {
  onBegin(config, suite) {
    this.suite = suite
  }

  // Failed tests are annotated by name too: otherwise a red job's only
  // annotation was "Process completed with exit code 1", and finding which
  // test failed meant reading the whole log.
  onEnd() {
    const tests = this.suite.allTests()
    this.report(tests.filter(test => test.outcome() === "flaky"), "warning", "Flaky test", "passed on retry. First attempt",
      count => `${count} flaky test(s), passed on retry`)
    this.report(tests.filter(test => test.outcome() === "unexpected"), "error", "Failed test", "failed",
      count => `${count} failed test(s)`)
  }

  report(tests, level, title, verb, heading) {
    if (tests.length === 0) return
    const rows = []
    for (const test of tests) {
      const file = path.relative(root, test.location.file).split(path.sep).join("/")
      // titlePath is [root, project, file, ...describes, title].
      const name = test.titlePath().slice(3).join(" › ")
      const error = stripVTControlCharacters(test.results.find(result => result.error)?.error?.message ?? "")
        .split("\n")[0]
      console.log(`::${level} file=${escapeProperty(file)},line=${test.location.line},title=${escapeProperty(title)}::${escapeData(`${name} ${verb}: ${error}`)}`)
      rows.push(`- \`${file}:${test.location.line}\` ${name}: ${error}`)
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${heading(tests.length)}\n\n${rows.join("\n")}\n\n`)
    }
  }

  printsToStdio() {
    return false
  }
}

module.exports = FlakyReport
