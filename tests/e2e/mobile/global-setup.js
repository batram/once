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
  const port = Number.parseInt(process.env.ONCE_MOBILE_TEST_PORT || "3211", 10)
  const healthUrl = `http://127.0.0.1:${port}/health`
  try {
    const occupied = await fetch(healthUrl, { signal: AbortSignal.timeout(500) })
    if (occupied.ok) {
      throw new Error(
        `Mobile test port ${port} is already serving another process; ` +
        "stop its tests or set ONCE_MOBILE_TEST_PORT to a free port"
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Mobile test port")) {
      throw error
    }
  }
  ensureFreshBundle(root)
  const server = spawn(process.execPath, ["tests/mobile-env/server.js"], {
    cwd: root,
    stdio: "inherit"
  })

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Mobile test server exited with ${server.exitCode}`)
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(500) })
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
