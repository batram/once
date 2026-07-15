const path = require("path")
const { spawn } = require("child_process")
const { once } = require("events")

module.exports = async function globalSetup() {
  const root = path.resolve(__dirname, "../../..")
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
