// Reports every test that failed once and passed on its retry as a GitHub
// warning annotation and a job-summary line. A flaky test no longer fails the
// run — the retry already gave it a second sample — but it stays visible on
// the run page instead of disappearing behind a green check.
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

  onEnd() {
    const flaky = this.suite.allTests().filter(test => test.outcome() === "flaky")
    if (flaky.length === 0) return
    const rows = []
    for (const test of flaky) {
      const file = path.relative(root, test.location.file).split(path.sep).join("/")
      // titlePath is [root, project, file, ...describes, title].
      const title = test.titlePath().slice(3).join(" › ")
      const error = stripVTControlCharacters(test.results.find(result => result.error)?.error?.message ?? "")
        .split("\n")[0]
      console.log(`::warning file=${escapeProperty(file)},line=${test.location.line},title=${escapeProperty("Flaky test")}::${escapeData(`${title} passed on retry. First attempt: ${error}`)}`)
      rows.push(`- \`${file}:${test.location.line}\` ${title}: ${error}`)
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${flaky.length} flaky test(s), passed on retry\n\n${rows.join("\n")}\n\n`)
    }
  }

  printsToStdio() {
    return false
  }
}

module.exports = FlakyReport
