/** A page with a minute of silence to seek in, served over http like any page. */
async function startMediaServer() {
  const http = require("node:http")
  const seconds = 60, rate = 8000
  const wav = Buffer.alloc(44 + seconds * rate)
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + seconds * rate, 4); wav.write("WAVEfmt ", 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write("data", 36)
  wav.writeUInt32LE(seconds * rate, 40); wav.fill(128, 44)
  const server = http.createServer((request, response) => {
    if (request.url.startsWith("/tone.wav")) {
      response.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "accept-ranges": "bytes" })
      response.end(wav)
      return
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end("<!doctype html><title>Listening</title><audio controls preload=\"auto\" src=\"/tone.wav\"></audio>")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

module.exports = { startMediaServer }
