const assert = require("node:assert/strict")
const http = require("node:http")
const { setTimeout: delay } = require("node:timers/promises")

// The counter changes a painted surface, not just a timer in the main process.
const fixture = `<!doctype html><title>Rendering probe</title>
<style>body{margin:0;background:#15ab65;color:white;font:40px monospace}
canvas{width:100%;height:180px}</style><canvas width="640" height="180"></canvas>
<button onclick="this.textContent='clicked'">probe</button><script>
window.probe = { token: crypto.randomUUID(), frames: 0, events: [] };
document.addEventListener('visibilitychange', () => probe.events.push(document.visibilityState));
const context = document.querySelector('canvas').getContext('2d');
function tick() {
  probe.frames++;
  context.fillStyle = probe.frames % 2 ? '#15ab65' : '#196dcc';
  context.fillRect(0, 0, 640, 180);
  context.fillStyle = 'white'; context.font = '40px monospace';
  context.fillText(location.pathname + ' frame ' + probe.frames, 20, 90);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
</script>`

async function bridge(window, method, ...args) {
  return window.webContents.executeJavaScript(
    `window.onceElectron.tabs[${JSON.stringify(method)}](...${JSON.stringify(args)})`
  )
}

async function sample(contents) {
  assert.equal(contents.isDestroyed(), false, "The live renderer was destroyed")
  assert.equal(contents.isBeingCaptured(), false, "A capturer is forcing page visibility")
  assert.equal(contents.getBackgroundThrottling(), true, "Background throttling was disabled")
  return contents.executeJavaScript("({...probe, visibility: document.visibilityState})")
}

function exposed(contents) {
  const { BrowserWindow } = require("electron")
  const windows = BrowserWindow.getAllWindows()
  const owner = windows.find(window => window.contentView.children.some(view => view.webContents === contents))
  assert.ok(owner, "The tab has no native window owner")
  assert.equal(owner.isAlwaysOnTop(), true, "Test window lost protection from other applications")
  const view = owner.contentView.children.find(child => child.webContents === contents)
  assert.equal(view.getVisible(), true, "The active tab view is hidden")
  const bounds = view.getBounds()
  const origin = owner.getContentBounds()
  const rect = { x: origin.x + bounds.x, y: origin.y + bounds.y,
    width: bounds.width, height: bounds.height }
  assert.ok(rect.width > 0 && rect.height > 0, "Empty content bounds")
  for (const other of windows.filter(window => window !== owner && window.isVisible())) {
    const cover = other.getBounds()
    assert.ok(!(cover.x <= rect.x && cover.y <= rect.y &&
      cover.x + cover.width >= rect.x + rect.width &&
      cover.y + cover.height >= rect.y + rect.height),
    "Test geometry fully covers a content region; not a tab regression")
  }
  return { windowId: owner.id, bounds: rect }
}

async function progressing(contents, token, stage, name) {
  // Allow the native occlusion tracker to settle, then require progress across
  // several intervals. No capturePage, focus, resize or visibility repair here.
  const geometry = exposed(contents)
  await delay(600)
  const observations = [await sample(contents)]
  for (let index = 0; index < 3; index++) {
    await delay(250)
    observations.push(await sample(contents))
  }
  stage(name, { contentsId: contents.id, geometry, observations })
  assert.ok(observations.every(value => value.token === token), "Transfer reloaded the page")
  if (observations.some((value, index) => value.visibility !== "visible" ||
    (index > 0 && value.frames <= observations[index - 1].frames))) {
    const error = new Error(`Frame production stopped at ${name}`)
    error.code = "TAB_FRAME_STALLED"
    throw error
  }
}

async function openProbe(window, url, webContents, waitFor) {
  await bridge(window, "openUrl", url, "blank")
  const contents = await waitFor("probe contents", () =>
    webContents.getAllWebContents().find(candidate => candidate.getURL() === url))
  await waitFor("probe loaded", async () => !contents.isLoading() &&
    contents.executeJavaScript("Boolean(window.probe)"))
  const tabs = await bridge(window, "getAll")
  return { contents, id: tabs.find(tab => tab.url === url).id, token: (await sample(contents)).token }
}

// Exercise the renderer's cross-window drop routing as well as direct IPC.
// This is a synthetic DOM drop, not an OS pointer-drag test.
async function dropTab(window, id, beforeId) {
  return window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('[data-tab-id="' + ${JSON.stringify(beforeId)} + '"]');
    if (!target) throw new Error('Missing destination tab');
    const transfer = new DataTransfer();
    transfer.setData('application/x-once-tab', ${JSON.stringify(id)});
    target.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: transfer,
      clientX: target.getBoundingClientRect().left
    }));
  })()`)
}

async function populatedDestination(context, first, second, origin) {
  const { source, waitFor, stage, BrowserWindow, webContents } = context
  const third = await openProbe(source, `${origin}/third`, webContents, waitFor)
  await bridge(source, "detach", third.id)
  const destination = await waitFor("populated destination", () =>
    BrowserWindow.getAllWindows().find(window => window.id !== source.id && window.isVisible()))
  const resident = await openProbe(destination, `${origin}/resident`, webContents, waitFor)
  await progressing(resident.contents, resident.token, stage, "resident-before-move")
  // First is attached but inactive in the source; the target already has an
  // active resident. Moving first must hide resident and preserve second.
  await bridge(source, "activate", second.id)
  await dropTab(destination, first.id, resident.id)
  await waitFor("drop ownership", async () =>
    (await bridge(destination, "getAll")).some(tab => tab.id === first.id && tab.active))
  await progressing(first.contents, first.token, stage, "inactive-to-populated")
  assert.equal((await sample(resident.contents)).visibility, "hidden")
  assert.equal((await bridge(source, "getAll")).find(tab => tab.active).id, second.id)
  await bridge(source, "moveHere", first.id)
  await progressing(first.contents, first.token, stage, "populated-return")
  assert.equal(destination.isDestroyed(), false, "Nonempty source must remain open")
  destination.destroy()
  await progressing(first.contents, first.token, stage, "after-other-window-closes")
}

async function runScenario({ source, waitFor, stage, BrowserWindow, webContents }) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.end(fixture)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    const first = await openProbe(source, `${origin}/first`, webContents, waitFor)
    await progressing(first.contents, first.token, stage, "initial")
    const second = await openProbe(source, `${origin}/second`, webContents, waitFor)
    // Calibrate the observer against an intentionally inactive tab. A forced
    // visible page (e.g. Playwright focus emulation) must fail this precondition.
    await delay(700)
    const hidden = await sample(first.contents)
    await delay(300)
    const hiddenLater = await sample(first.contents)
    assert.equal(hiddenLater.visibility, "hidden", "Inactive page is being forced visible")
    assert.equal(hiddenLater.frames, hidden.frames, "Inactive page still produces frames")
    stage("observer-calibrated")
    for (let cycle = 0; cycle < 3; cycle++) {
      await bridge(source, "activate", first.id)
      await progressing(first.contents, first.token, stage, `activate-${cycle}`)
      await bridge(source, "reorder", first.id, second.id)
      await progressing(first.contents, first.token, stage, `reorder-${cycle}`)
      await bridge(source, "detach", first.id)
      const destination = await waitFor("detached window", () =>
        BrowserWindow.getAllWindows().find(window => window.id !== source.id && window.isVisible()))
      await progressing(first.contents, first.token, stage, `detach-${cycle}`)
      await bridge(source, "moveHere", first.id, second.id)
      await waitFor("empty destination closes", () => destination.isDestroyed())
      await progressing(first.contents, first.token, stage, `return-${cycle}`)
      await bridge(source, "activate", second.id)
      await progressing(second.contents, second.token, stage, `second-${cycle}`)
    }
    await populatedDestination({ source, waitFor, stage, BrowserWindow, webContents },
      first, second, origin)
  } finally {
    server.closeAllConnections()
    server.close()
  }
}

module.exports = { runScenario }
