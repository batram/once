const http = require("node:http")

// The browser creates a real raster image. The visible words are not DOM text.
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
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
const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 360;
const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0,0,1000,360);
context.fillStyle = '#14253d'; context.font = '48px Arial';
context.fillText('Select these words', 65, 100);
context.fillText('Native Apple Vision', 65, 185);
context.fillText('Copy 12345 and punctuation.', 65, 270);
document.querySelector('img').src = canvas.toDataURL('image/png');
</script></body></html>`

async function startImageTextServer(port = 0) {
  let raster = null
  const server = http.createServer((request, response) => {
    if (request.url === "/image.png" && raster) {
      response.writeHead(200, { "content-type": "image/png" })
      response.end(raster)
      return
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(html)
  })
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`,
    setImage: (bytes) => { raster = bytes },
    close: () => new Promise(resolve => server.close(resolve)) }
}
module.exports = { startImageTextServer }
if (require.main === module) startImageTextServer(48765).then(server => console.log(server.origin))
