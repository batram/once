// Runs `npm run check:static` and the unit tests against what is being pushed,
// so a dead export, a file over the structural limit or a broken unit test
// fails here instead of on CI minutes later. Wired as the pre-push hook by
// install-git-hooks.js; `git push --no-verify` skips it.
//
// The checks run on the pushed commit, not on the working tree: parallel work
// often leaves uncommitted files in this checkout, and those must neither
// block a push nor hide a problem in what is actually sent. When the pushed
// commit is HEAD and the tree is clean, they run in place; otherwise in a
// throwaway worktree whose node_modules mirrors this one.
const { execFileSync, spawn, spawnSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const root = path.resolve(__dirname, "..")
const { scripts } = require(path.join(root, "package.json"))
// Each step of check:static runs on its own, so one push reports every
// failing check rather than stopping at the first.
const checks = scripts["check:static"].split("&&")
  .map(step => step.trim().replace(/^npm run /, ""))
  .map(name => ({ name, command: `npm run -s ${name}` }))
// test:unit builds the packages first; here the build has already run, and a
// second one copying assets into dist while knip reads it could race.
const unitBuild = /^npm run build:packages && /
if (!unitBuild.test(scripts["test:unit"])) throw new Error("pre-push: test:unit no longer starts with build:packages")
checks.push({ name: "test:unit", command: scripts["test:unit"].replace(unitBuild, "") })
const zero = /^0+$/

const git = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

// Git passes one "<local ref> <local sha> <remote ref> <remote sha>" line per
// pushed ref. A deleted ref has an all-zero local sha and nothing to check.
const pushed = [...new Set(fs.readFileSync(0, "utf8").split("\n")
  .map(line => line.trim().split(/\s+/)[1])
  .filter(sha => sha && !zero.test(sha)))]

// Workspace packages export their built dist, so knip and the unit tests need
// a build of the pushed sources first, as on CI. The checks after it are
// independent and run at once; each one's output is held and printed whole,
// in the order above, as soon as it and every check before it have finished.
async function runChecks(cwd) {
  const failed = []
  if (spawnSync("npm run -s build:packages", { cwd, stdio: "inherit", shell: true }).status !== 0) failed.push("build:packages")
  // Piped output is not a terminal; keep the colours a terminal push shows.
  const env = process.stdout.isTTY ? { ...process.env, FORCE_COLOR: "1" } : process.env
  const done = []
  let printed = 0
  const printReady = () => {
    for (; done[printed]; printed++) {
      const { name, status, output, seconds } = done[printed]
      console.log(`\npre-push: ${name} ${status === 0 ? "passed" : "FAILED"} (${seconds.toFixed(1)} s)`)
      if (output.length > 0) process.stdout.write(Buffer.concat(output))
      if (status !== 0) failed.push(name)
    }
  }
  await Promise.all(checks.map(({ name, command }, index) => new Promise(resolve => {
    const started = performance.now()
    const output = []
    const child = spawn(command, { cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", chunk => output.push(chunk))
    child.stderr.on("data", chunk => output.push(chunk))
    child.on("error", error => output.push(Buffer.from(`${error.stack}\n`)))
    // "close" waits for both pipes to drain; an undetermined status is a failure.
    child.on("close", status => {
      done[index] = { name, status: status ?? 1, output, seconds: (performance.now() - started) / 1000 }
      printReady()
      resolve()
    })
  })))
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
    link(path.resolve(root, nested), path.resolve(worktree, nested))
  }
  return links
}

function isWorkspaceLink(file) {
  if (!fs.lstatSync(file).isSymbolicLink()) return false
  const real = fs.realpathSync(file)
  return !path.relative(root, real).startsWith("..") && !real.includes(`${path.sep}node_modules${path.sep}`)
}

async function checkInWorktree(sha) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "once-pre-push-"))
  git(["worktree", "add", "--detach", "--quiet", worktree, sha])
  let links = []
  try {
    links = mirrorNodeModules(worktree)
    return await runChecks(worktree)
  } finally {
    // Junctions are unlinked first, so removing the worktree can never reach
    // through one into this checkout's node_modules.
    for (const junction of links.reverse()) fs.unlinkSync(junction)
    git(["worktree", "remove", "--force", worktree])
  }
}

async function main() {
  if (pushed.length === 0) return
  const head = git(["rev-parse", "HEAD"])
  // Files hidden only by .git/info/exclude (local scratch folders) leave
  // `git status` clean, yet linters walking the checkout still see them; with
  // any of them present the checks run in a worktree that holds just the commit.
  const locallyExcluded = git(["ls-files", "--others", "--exclude-standard"]) !==
    git(["ls-files", "--others", "--exclude-per-directory=.gitignore"])
  const clean = git(["status", "--porcelain"]) === "" && !locallyExcluded
  let failed = []
  for (const sha of pushed) {
    console.log(`pre-push: static checks and unit tests on ${sha.slice(0, 8)}${sha === head && clean ? "" : " (clean worktree)"}`)
    failed = failed.concat(sha === head && clean ? await runChecks(root) : await checkInWorktree(sha))
  }
  if (failed.length > 0) {
    console.error(`\npre-push: failed ${[...new Set(failed)].join(", ")}. Fix them, or push with --no-verify.`)
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
