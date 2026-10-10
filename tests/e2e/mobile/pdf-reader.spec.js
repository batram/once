const { test,expect }=require("@playwright/test")
const {gotoMobileApp,testServerUrl}=require("./helpers/mobile-app")
const {openSettingsSection}=require("./helpers/settings")
const {textPdf}=require("../shared/pdf-text-fixture")

for(const colorScheme of ["light","dark"]){
  test(`mobile web Reader extracts PDF text in ${colorScheme}`,async({page},testInfo)=>{
    await page.emulateMedia({colorScheme})
    await page.route("**/fixtures/pdf-reader",route=>route.fulfill({contentType:"application/pdf",body:textPdf()}))
    await gotoMobileApp(page)
    await openSettingsSection(page,"theme")
    await page.getByTestId("theme").selectOption(colorScheme)
    await page.getByTestId("reading-menu").click()
    const address=page.getByTestId("reading-url-input")
    await address.fill(await testServerUrl(page,"/fixtures/pdf-reader"));await address.press("Enter")
    await page.locator("#reading_reader_toggle").click()
    const frame=page.locator(".once-reader-host-frame").contentFrame()
    await expect(frame.locator("article")).toContainText("Readable PDF text across platforms.")
    const geometry=await frame.locator("article").evaluate(article=>({width:article.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth,background:getComputedStyle(document.documentElement).backgroundColor}))
    expect(geometry.width).toBeGreaterThan(200);expect(geometry.overflow).toBe(false)
    expect(geometry.background).toBe(colorScheme==="dark"?"rgb(40, 42, 54)":"rgb(246, 246, 239)")
    await page.screenshot({path:testInfo.outputPath(`pdf-reader-${colorScheme}.png`)})
  })
}
