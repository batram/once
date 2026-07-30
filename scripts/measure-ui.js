"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const { chromium } = require("playwright")
const {
  createServer,
  root
} = require("../tests/e2e/design-system/static-server")

function argumentsFrom(commandLine) {
  const targetArgument = commandLine.find((value) => value.startsWith("--target="))
  const selector = commandLine.find((value) => !value.startsWith("--"))
  return {
    selector,
    target: targetArgument?.slice("--target=".length) || "shared"
  }
}

function sourceIdentity(target) {
  const files = [
    "packages/ui-web/public/shell.html",
    "packages/ui-web/public/static/css/style.css",
    ...fs.readdirSync(path.join(
      root,
      "packages",
      "ui-web",
      "public",
      "static",
      "css",
      "parts"
    )).filter((file) => file.endsWith(".css"))
      .map((file) => `packages/ui-web/public/static/css/parts/${file}`)
  ]
  if (target === "mobile") files.push("apps/mobile/src/mobile.css")
  const hash = crypto.createHash("sha256")
  for (const file of files.sort()) {
    hash.update(file)
    hash.update(fs.readFileSync(path.join(root, file)))
  }
  return {
    kind: "source-fixture",
    files: files.length,
    sha256: hash.digest("hex")
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return server.address().port
}

async function main() {
  const { selector, target } = argumentsFrom(process.argv.slice(2))
  if (!selector) {
    console.error('Usage: npm run measure -- "<selector>" [--target=shared|mobile]')
    process.exitCode = 2
    return
  }
  if (!["shared", "mobile"].includes(target)) {
    console.error(`Unsupported target "${target}"; use shared or mobile.`)
    process.exitCode = 2
    return
  }

  const server = createServer()
  const port = await listen(server)
  const browser = await chromium.launch()
  try {
    const viewport = { width: 960, height: 720 }
    const page = await browser.newPage({ viewport })
    const suffix = target === "mobile" ? "?target=mobile" : ""
    await page.goto(`http://127.0.0.1:${port}/static/sidepanel.html${suffix}`)
    const matches = page.locator(selector)
    if (await matches.count()) {
      await matches.first().evaluate((element) => {
        const panel = element.closest(".panel")
        const leftPanel = document.querySelector("#left_panel")
        if (panel?.dataset.panel && leftPanel) {
          leftPanel.setAttribute("active_panel", panel.dataset.panel)
        }
      })
    }
    const result = await matches.evaluateAll((elements) => {
      const rectangle = (element) => {
        const bounds = element.getBoundingClientRect()
        return {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          centerX: bounds.x + bounds.width / 2,
          centerY: bounds.y + bounds.height / 2
        }
      }
      const metrics = (element) => {
        const style = getComputedStyle(element)
        const box = rectangle(element)
        const parentBox = element.parentElement
          ? rectangle(element.parentElement)
          : null
        const siblingBoxes = [...(element.parentElement?.children || [])]
          .filter((sibling) => sibling !== element)
          .map((sibling) => ({
            selector: identify(sibling),
            ...rectangle(sibling),
            centerOffsetX: rectangle(sibling).centerX - box.centerX,
            centerOffsetY: rectangle(sibling).centerY - box.centerY
          }))
        return {
          selector: identify(element),
          tag: element.tagName.toLowerCase(),
          box,
          padding: {
            top: style.paddingTop,
            right: style.paddingRight,
            bottom: style.paddingBottom,
            left: style.paddingLeft
          },
          border: {
            top: style.borderTopWidth,
            right: style.borderRightWidth,
            bottom: style.borderBottomWidth,
            left: style.borderLeftWidth
          },
          typography: {
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            verticalAlign: style.verticalAlign
          },
          overflow: {
            x: style.overflowX,
            y: style.overflowY,
            scrollWidth: element.scrollWidth,
            scrollHeight: element.scrollHeight,
            clipsContent: element.scrollWidth > element.clientWidth ||
              element.scrollHeight > element.clientHeight
          },
          parentCenterOffset: parentBox
            ? {
              x: box.centerX - parentBox.centerX,
              y: box.centerY - parentBox.centerY
            }
            : null,
          siblings: siblingBoxes
        }
      }
      return elements.map(metrics)

      function identify(element) {
        if (element.id) return `#${element.id}`
        if (element.classList.length) {
          return `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`
        }
        return element.tagName.toLowerCase()
      }
    })
    console.log(JSON.stringify({
      renderer: target,
      viewport,
      source: sourceIdentity(target),
      matched: result.length,
      elements: result
    }, null, 2))
    if (!result.length) process.exitCode = 1
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
