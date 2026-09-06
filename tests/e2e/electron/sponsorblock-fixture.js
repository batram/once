// A local response at a YouTube URL exercises the unmodified content script.
// No vote, submission, or other write is sent to SponsorBlock's public service.
async function verifySponsorBlock(electronApp, window, expect) {
  const host = await window.evaluate(async () =>
    (await window.onceElectron.extensions.installed()).find(item => item.id === "sponsorBlocker@ajay.app").host)
  const url = "https://www.youtube.com/watch?v=OnceTest123"
  await electronApp.evaluate(({ session }, host) => {
    session.fromPartition(`persist:once-ext:${host}`).protocol.handle("https", request => {
      if (new URL(request.url).pathname.startsWith("/api/skipSegments/")) {
        return Response.json([{ videoID: "OnceTest123", segments: [{
          segment: [0.1, 1.5], UUID: "once-fixture-segment", category: "sponsor", actionType: "skip",
          videoDuration: 2, locked: 0, votes: 1
        }] }])
      }
      return Response.json([], { status: 200 })
    })
    session.fromPartition("persist:once-browser-v2").protocol.handle("https", () => new Response(`<!doctype html>
      <title>Once SponsorBlock fixture</title><div id="movie_player" class="html5-video-player">
      <video class="html5-main-video" muted autoplay></video><div class="ytp-chrome-bottom"><div class="ytp-progress-bar-container"></div>
      <div class="ytp-chrome-controls"><div class="ytp-left-controls"></div><div class="ytp-right-controls"></div></div></div></div>
      <script>
      const video = document.querySelector('video');
      video.addEventListener('seeking', () => { document.body.dataset.seek = String(video.currentTime) });
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
      const context = canvas.getContext('2d'); const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' }); const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const drawing = setInterval(() => { context.fillStyle = Date.now() % 2 ? 'blue' : 'red'; context.fillRect(0, 0, 64, 64) }, 30);
      recorder.onstop = () => {
        clearInterval(drawing); stream.getTracks().forEach(track => track.stop());
        video.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })); video.play().catch(error => { document.body.dataset.mediaError = String(error) });
      };
      recorder.start(); setTimeout(() => recorder.stop(), 2000);
      </script>`, { headers: { "content-type": "text/html" } }))
  }, host)
  try {
    await window.evaluate(url => window.onceElectron.tabs.create(url, true), url)
    await expect.poll(() => electronApp.evaluate(async ({ webContents }, { host, url }) => {
      const background = webContents.getAllWebContents().find(item => item.getURL().startsWith(`moz-extension://${host}/_generated_background_page`))
      if (!background) return null
      return background.executeJavaScript(`(async () => {
        const [tab] = await browser.tabs.query({ url: ${JSON.stringify(url)} });
        if (!tab) return null;
        try { return await browser.tabs.sendMessage(tab.id, { message: 'isInfoFound' }) } catch { return null }
      })()`)
    }, { host, url }), { timeout: 30000 }).toMatchObject({ videoID: "OnceTest123", found: true })
    await expect.poll(() => electronApp.evaluate(async ({ webContents }, url) => {
      const page = webContents.getAllWebContents().find(item => item.getURL() === url)
      return page ? page.executeJavaScript("Number(document.body.dataset.seek ?? 0)") : 0
    }, url), { timeout: 15000 }).toBeGreaterThanOrEqual(1.4)
  } finally {
    await electronApp.evaluate(({ session }, host) => {
      session.fromPartition(`persist:once-ext:${host}`).protocol.unhandle("https")
      session.fromPartition("persist:once-browser-v2").protocol.unhandle("https")
    }, host)
  }
}

module.exports = { verifySponsorBlock }
