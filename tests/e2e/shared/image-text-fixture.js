const http = require("node:http")

const SAMPLE = { width: 1000, height: 360, font: "48px Arial",
  lines: [["Select these words", 65, 100], ["Native Apple Vision", 65, 185], ["Copy 12345 and punctuation.", 65, 270]] }

// The browser creates a real raster image. The visible words are not DOM text.
// They are drawn as the page loads: a canvas redrawn later reads back blank
// on a hidden desktop, and recognition finds nothing.
const html = (text) => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Image text selection fixture</title><style>
body { margin: 24px; font: 16px system-ui; color: #172338; background: #f5f7fa; }
main { max-width: 800px; margin: auto; }
img { display: block; width: 100%; height: 280px; object-fit: contain; border: 2px solid #768398; background: #dae1eb; }
.spacer { height: 900px; }
@media (max-width: 500px) { body { margin: 16px; } img { height: 230px; } }
@media (prefers-color-scheme: dark) { body { color: #eef3ff; background: #17202f; } }
</style></head><body><main><h1>Text inside an image</h1>
<p>Right-click or long-press the image, then select its text. Scroll to check alignment.</p>
<a href="/should-not-navigate"><img id="sample" alt="OCR test image"></a>
<p>The three lines above are pixels. The text should copy without opening the link.</p>
<div class="spacer"></div><p>End of scroll test</p></main><script>
const text = ${JSON.stringify(text)};
const canvas = document.createElement('canvas'); canvas.width = text.width; canvas.height = text.height;
const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0,0,text.width,text.height);
context.fillStyle = '#14253d'; context.font = text.font;
for (const [line, x, y] of text.lines) context.fillText(line, x, y);
document.querySelector('img').src = canvas.toDataURL('image/png');
</script></body></html>`

async function startImageTextServer(port = 0) {
  let raster = null
  let loads = 0
  let manifests = 0
  let text = SAMPLE
  const server = http.createServer((request, response) => {
    if (request.url === "/manifest.webmanifest") {
      manifests++
      response.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-store" })
      response.end("{}")
      return
    }
    if (request.url === "/image.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" })
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="360"><rect width="1000" height="360" fill="white"/><text x="65" y="100" font-family="Arial" font-size="48">Select these words</text></svg>')
      return
    }
    if (request.url === "/image.png" && raster) {
      loads++
      // Uncached, so any load past the page's own reaches the server and is counted.
      response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" })
      response.end(raster)
      return
    }
    if (request.url === "/negotiated.png" && raster) {
      // Opened as its own tab, an image whose response varies by Accept (as image CDNs serving AVIF
      // do) gives the protocol no copy of its bytes; so does no-store or a sandboxing CSP.
      response.writeHead(200, { "content-type": "image/png", vary: "Accept" })
      response.end(raster)
      return
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    // The fixture again inside a cross-site iframe (localhost vs 127.0.0.1),
    // which runs out of process: offset, bordered and in a scrolled page.
    if (request.url === "/framed") {
      response.end(`<!doctype html><title>Framed image text fixture</title><body style="margin:0;height:2000px">
        <iframe id="frame" src="http://localhost:${server.address().port}/"
          style="position:absolute;left:60px;top:140px;width:640px;height:520px;border:9px solid #456"></iframe></body>`)
      return
    }
    response.end(html(text))
  })
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`,
    setImage: (bytes) => { raster = bytes; loads = 0 },
    /** How often `/image.png` was loaded since `setImage`. */
    imageLoads: () => loads,
    manifestLoads: () => manifests,
    /** What the page's image shows from its next load: `{ width, height, font, lines: [[text, x, y]] }`; null for the sample. */
    setText: (drawn) => { text = drawn ? { ...SAMPLE, ...drawn } : SAMPLE },
    close: () => new Promise(resolve => server.close(resolve)) }
}
module.exports = { startImageTextServer }
if (require.main === module) startImageTextServer(48765).then(server => console.log(server.origin))
