const path = require("path")
const { spawn, spawnSync } = require("child_process")
const { once } = require("events")
const { appRoot, packageSources, webBundleStaleness } = require("./build-freshness")

// Rebuild the served bundle when it was not produced by `mobile web --e2e`, so
// running Playwright directly (after `npm run check`, say) tests the same
// bundle `npm run test:mobile:web` would have built.
function ensureFreshBundle(root) {
  const reason = webBundleStaleness([
    path.join(appRoot, "src"),
    path.join(appRoot, "webpack.config.js"),
    ...packageSources()
  ])
  if (!reason) return
  console.log(`Rebuilding the mobile web bundle because ${reason}`)
  const npmCli = process.env.npm_execpath
  const build = npmCli
    ? spawnSync(process.execPath, [npmCli, "run", "mobile", "--", "web", "--channel", "dev", "--e2e"],
      { cwd: root, stdio: "inherit" })
    : { status: 1, error: new Error("run the mobile web suite through npm") }
  if (build.status !== 0) {
    throw new Error(
      `Unable to rebuild the mobile web bundle (${build.error?.message || `exit ${build.status}`}); ` +
      "run `npm run test:mobile:web`"
    )
  }
}

module.exports = async function globalSetup() {
  const root = path.resolve(__dirname, "../../..")
  ensureFreshBundle(root)
  const server = spawn(process.execPath, ["tests/mobile-env/server.js"], {
    cwd: root,
    stdio: "inherit"
  })

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Mobile test server exited with ${server.exitCode}`)
    try {
      const response = await fetch("http://127.0.0.1:3211/health")
      if (response.ok) {
        return async () => {
          server.kill()
          await Promise.race([
            once(server, "exit"),
            new Promise(resolve => setTimeout(resolve, 1_000))
          ])
          if (server.exitCode === null) server.kill("SIGKILL")
        }
      }
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  server.kill()
  throw new Error("Mobile test server did not become ready on port 3211")
}
