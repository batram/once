const { test, expect } = require("@playwright/test")

const { gotoMobileApp } = require("./helpers/mobile-app")
const { openSettingsSection } = require("./helpers/settings")
const exceptions = require("./button-adoption-exceptions.json")

// The design-system fixture renders 33 buttons and every one already carries
// .button, so a guard there passes while hundreds of real controls sit outside
// the contract. The controls that matter are built in TypeScript from settings
// data and only exist once a section has rendered, which is why this guard runs
// on the mobile web surface rather than as a source lint or a shell fixture
// check. Its coverage is therefore exactly the sections walked below.
const sections = ["sources", "filters", "redirects", "swipe", "errors"]

const entries = [...exceptions.boxOwning, ...exceptions.unclassified]
const reviewed = new Set(entries.map(entry => entry.family))

function familiesLackingPrimitive() {
  const counts = {}
  const selector = "button, input[type='button'], input[type='submit']"
  for (const control of document.querySelectorAll(selector)) {
    if (control.classList.contains("button")) continue
    const family = control.classList[0] || "(no class)"
    counts[family] = (counts[family] || 0) + 1
  }
  return counts
}

test("reviewed button-adoption exceptions carry ownership and a deletion condition", () => {
  for (const entry of entries) {
    expect(entry.family).toBeTruthy()
    expect(entry.reason).toBeTruthy()
    expect(entry.phase).toMatch(/^\d+\.\d+$/)
    expect(entry.removeWhen).toBeTruthy()
  }
})

test("every native control adopts .button or is a reviewed exception", async ({ page }) => {
  await gotoMobileApp(page)

  const seen = new Map()
  const record = (counts) => {
    for (const [family, count] of Object.entries(counts)) {
      seen.set(family, (seen.get(family) || 0) + count)
    }
  }

  record(await page.evaluate(familiesLackingPrimitive))
  for (const section of sections) {
    await openSettingsSection(page, section)
    record(await page.evaluate(familiesLackingPrimitive))
  }

  const unreviewed = [...seen.keys()].filter(family => !reviewed.has(family)).sort()
  expect(
    unreviewed,
    `Native controls outside the .button contract and not reviewed: ${unreviewed.join(", ")}`
  ).toEqual([])

  // A family that no longer appears is debt that was paid; its entry must go so
  // the list cannot quietly outlive the controls it excuses. Entries marked
  // `conditional` render only in states these sections do not reach, so this
  // guard cannot speak to them either way and says so rather than guessing.
  const stale = [...entries]
    .filter(entry => !entry.conditional && !seen.has(entry.family))
    .map(entry => entry.family)
    .sort()
  expect(
    stale,
    `Reviewed families no longer rendered by the covered sections: ${stale.join(", ")}`
  ).toEqual([])
})
