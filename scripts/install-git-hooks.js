// Points this checkout's git hooks at .githooks, so the pre-push check runs
// without a hook manager. It runs on `npm install`; outside a git checkout
// (an unpacked tarball) and on CI, where nobody pushes, it does nothing.
const { execFileSync } = require("child_process")
const path = require("path")

const root = path.resolve(__dirname, "..")
if (process.env.CI) process.exit(0)
try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" })
} catch {
  process.exit(0)
}
execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root })
