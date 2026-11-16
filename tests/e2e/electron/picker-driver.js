// Drives the source picker overlay the way a user does. The overlay sits in a
// closed shadow root, in a world of its own, and answers only to trusted
// events, so nothing the page's world can do reaches it. The tests go in from
// outside the page instead, through the tab's debugger: DOM commands see into
// the closed root, and Input commands raise real (trusted) input.

/** Runs one picker command against the tab showing `url`, in the main process. */
function pickerCommand(electronApp, url, command) {
  return electronApp.evaluate(async ({ webContents }, request) => {
    const contents = webContents
      .getAllWebContents()
      .find((candidate) => candidate.getURL() === request.url)
    if (!contents) throw new Error(`Missing webContents for ${request.url}`)
    const cdp = contents.debugger
    if (!cdp.isAttached()) {
      cdp.attach("1.3")
      // The hidden test window does not hold focus; typed text needs it.
      await cdp.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true })
    }
    const { command } = request
    const mouse = async (x, y) => {
      const point = { x, y, button: "left", clickCount: 1 }
      await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
      await cdp.sendCommand("Input.dispatchMouseEvent", { ...point, type: "mousePressed" })
      await cdp.sendCommand("Input.dispatchMouseEvent", { ...point, type: "mouseReleased" })
    }
    if (command.clickAt) {
      await mouse(command.clickAt.x, command.clickAt.y)
      return null
    }

    const { root } = await cdp.sendCommand("DOM.getDocument", { depth: -1, pierce: true })
    const findHost = (node) => {
      if (node.localName === "once-source-picker") return node
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
        const found = findHost(child)
        if (found) return found
      }
      return null
    }
    const host = findHost(root)
    if (command.present) return Boolean(host)
    if (!host || !host.shadowRoots?.length) throw new Error("The picker overlay is not open")
    const { nodeIds } = await cdp.sendCommand("DOM.querySelectorAll", {
      nodeId: host.shadowRoots[0].nodeId,
      selector: command.selector
    })
    const call = async (nodeId, body) => {
      const { object } = await cdp.sendCommand("DOM.resolveNode", { nodeId })
      const { result } = await cdp.sendCommand("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: body,
        returnByValue: true
      })
      return result.value
    }
    if (command.read) {
      const values = []
      for (const nodeId of nodeIds) {
        values.push(await call(nodeId, `function () { return this[${JSON.stringify(command.read)}] }`))
      }
      return values
    }
    const nodeId = nodeIds[command.index || 0]
    if (nodeId === undefined) throw new Error(`No picker element matches ${command.selector}`)
    if (command.scriptClick) {
      // What a script can do at most: a synthetic click, never a trusted one.
      await call(nodeId, "function () { this.click() }")
      return null
    }
    if (command.click) {
      const { model } = await cdp.sendCommand("DOM.getBoxModel", { nodeId })
      const [x1, y1, , , x3, y3] = model.content
      await mouse((x1 + x3) / 2, (y1 + y3) / 2)
      return null
    }
    if (typeof command.type === "string") {
      await cdp.sendCommand("DOM.focus", { nodeId })
      await call(nodeId, "function () { this.select() }")
      await cdp.sendCommand("Input.insertText", { text: command.type })
      return null
    }
    throw new Error("Unknown picker command")
  }, { url, command })
}

function pickerDriver(electronApp, url) {
  const run = (command) => pickerCommand(electronApp, url, command)
  return {
    /** Whether the overlay is in the page. */
    present: () => run({ present: true }),
    /** One property of every overlay element matching the selector. */
    read: (selector, property) => run({ selector, read: property }),
    /** A real mouse click on the overlay element. */
    click: (selector, index = 0) => run({ selector, index, click: true }),
    /** `element.click()` from script: synthetic, as a page could raise it. */
    scriptClick: (selector, index = 0) => run({ selector, index, scriptClick: true }),
    /** Replaces the field's text with real typed input. */
    type: (selector, text, index = 0) => run({ selector, index, type: text }),
    /** A real mouse click at viewport coordinates, for picking page elements. */
    clickAt: (x, y) => run({ clickAt: { x, y } })
  }
}

module.exports = { pickerDriver }
