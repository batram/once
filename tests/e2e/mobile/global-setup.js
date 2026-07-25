const path = require("path")
const { spawnSync } = require("child_process")
const { appRoot, packageSources, webBundleStaleness } = require("./build-freshness")
const { readHealth, startTestServer } = require("./test-server-process")

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
  const expectedOwner = process.env.ONCE_MOBILE_TEST_OWNER || ""
  try {
    const health = await readHealth(port)
    if (process.env.ONCE_MOBILE_TEST_SERVER_EXTERNAL === "1" &&
        expectedOwner && health.owner === expectedOwner) {
      ensureFreshBundle(root)
      return
    }
    throw new Error(
      `Mobile test port ${port} is owned by another process ` +
      `(pid ${health.pid || "unknown"}, owner ${health.owner || "unidentified"}); ` +
      "stop its tests or choose another port"
    )
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Mobile test port")) {
      throw error
    }
  }
  ensureFreshBundle(root)
  const testServer = startTestServer({ port })
  const started = await testServer.ready
  if (started.port !== port) {
    await testServer.stop()
    throw new Error(`Mobile test server requested port ${port} but bound port ${started.port}`)
  }
  return () => testServer.stop()
}
