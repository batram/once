// Runs `npm run check:static` against what is being pushed, so a
// dead export or a file over the structural limit fails here in seconds
// instead of on CI minutes later. Wired as the pre-push hook by
// install-git-hooks.js; `git push --no-verify` skips it.
//
// The checks run on the pushed commit, not on the working tree: parallel work
// often leaves uncommitted files in this checkout, and those must neither
// block a push nor hide a problem in what is actually sent. When the pushed
// commit is HEAD and the tree is clean, they run in place; otherwise in a
// throwaway worktree whose node_modules mirrors this one.
const { execFileSync, spawnSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const root = path.resolve(__dirname, "..")
// Each step of check:static runs on its own, so one push reports every
// failing check rather than stopping at the first.
const checks = require(path.join(root, "package.json")).scripts["check:static"]
  .split("&&").map(step => step.trim().replace(/^npm run /, ""))
const zero = /^0+$/

const git = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

// Git passes one "<local ref> <local sha> <remote ref> <remote sha>" line per
// pushed ref. A deleted ref has an all-zero local sha and nothing to check.
const pushed = [...new Set(fs.readFileSync(0, "utf8").split("\n")
  .map(line => line.trim().split(/\s+/)[1])
  .filter(sha => sha && !zero.test(sha)))]

// Workspace packages export their built dist, so knip needs a build of the
// pushed sources to follow imports between packages, as on CI.
function runChecks(cwd) {
  const failed = []
  for (const check of ["build:packages", ...checks]) {
    const result = spawnSync(`npm run -s ${check}`, { cwd, stdio: "inherit", shell: true })
    if (result.status !== 0) failed.push(check)
  }
  return failed
}

// Every entry is a junction to this checkout's copy except the workspace
// links, which are pointed at the worktree's own packages so that imports
// through package names resolve to the pushed sources.
function mirrorNodeModules(worktree) {
  const source = path.join(root, "node_modules")
  const target = path.join(worktree, "node_modules")
  const links = []
  const link = (from, to) => { fs.symlinkSync(from, to, "junction"); links.push(to) }
  fs.mkdirSync(target)
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    if (!entry.name.startsWith("@") || !fs.readdirSync(from).some(name => isWorkspaceLink(path.join(from, name)))) {
      link(from, path.join(target, entry.name))
      continue
    }
    fs.mkdirSync(path.join(target, entry.name))
    for (const name of fs.readdirSync(from)) {
      const scoped = path.join(from, name)
      const real = isWorkspaceLink(scoped)
        ? path.join(worktree, path.relative(root, fs.realpathSync(scoped)))
        : scoped
      link(real, path.join(target, entry.name, name))
    }
  }
  // Nested node_modules hold packages whose versions differ from the root's.
  for (const nested of git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]).split("\n")) {
    if (!/^(apps|packages)\/[^/]+\/node_modules\/$/.test(nested)) continue
    link(path.join(root, nested), path.join(worktree, nested))
  }
  return links
}

function isWorkspaceLink(file) {
  if (!fs.lstatSync(file).isSymbolicLink()) return false
  const real = fs.realpathSync(file)
  return !path.relative(root, real).startsWith("..") && !real.includes(`${path.sep}node_modules${path.sep}`)
}

function checkInWorktree(sha) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "once-pre-push-"))
  git(["worktree", "add", "--detach", "--quiet", worktree, sha])
  let links = []
  try {
    links = mirrorNodeModules(worktree)
    return runChecks(worktree)
  } finally {
    // Junctions are unlinked first, so removing the worktree can never reach
    // through one into this checkout's node_modules.
    for (const junction of links.reverse()) fs.unlinkSync(junction)
    git(["worktree", "remove", "--force", worktree])
  }
}

if (pushed.length === 0) process.exit(0)
const head = git(["rev-parse", "HEAD"])
const clean = git(["status", "--porcelain"]) === ""
let failed = []
for (const sha of pushed) {
  console.log(`pre-push: static checks on ${sha.slice(0, 8)}${sha === head && clean ? "" : " (clean worktree)"}`)
  failed = failed.concat(sha === head && clean ? runChecks(root) : checkInWorktree(sha))
}
if (failed.length > 0) {
  console.error(`\npre-push: failed ${[...new Set(failed)].join(", ")}. Fix them, or push with --no-verify.`)
  process.exit(1)
}
