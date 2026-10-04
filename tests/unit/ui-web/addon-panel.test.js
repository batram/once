const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const tick = () => new Promise(resolve => setImmediate(resolve))

function setup() {
  const { window } = parseHTML('<html><body><div id="left_panel" active_panel="stories"><div id="menu"><button id="stories_menu_btn"></button><div id="status_dock"></div></div><div id="left_main"><div id="stories_panel"><div id="selected_container"></div></div></div></div></body></html>')
  for (const key of ["document", "HTMLElement", "CustomEvent", "Event", "MutationObserver"]) global[key] = window[key]
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", { configurable: true,
    get() { return this.querySelector("option[selected]")?.value || "" },
    set(value) { for (const option of this.querySelectorAll("option")) option.selected = option.value === value }
  })
  const page = require("../../../packages/ui-web/dist/addons/pageAddons")
  const { addonPanelConversations } = require("../../../packages/ui-web/dist/addons/addonPanel")
  const selected = []
  const opened = []
  const story = { href: "https://example.test/a", title: "Alpha", matches_url: url => ["https://example.test/a", "https://mirror.test/a", "https://example.test/comments"].includes(url), matches_comment_url: url => url === "https://example.test/comments" }
  const client = { subscribe: (_name, callback) => selected.push(callback), openUrl: (...values) => opened.push(values),
    findStoryByUrl: async url => story.matches_url(url) ? story : url === "https://example.test/b" ? {href:url,title:"Beta",matches_url:href=>href===url,matches_comment_url:()=>false} : null }
  const surface = addonPanelConversations(client)
  const handle = (tray = "summary", href = story.href) => {
    const state = {addon:{id:"research",name:"Research tools",shortName:"Research"},tray:{id:tray,title:tray === "summary" ? "Summary" : "Translation"},story:{href,title:href === story.href ? "Alpha" : "Beta"},view:{messages:[],composer:"Ask"},draft:"",busy:false,error:""}
    const listeners = new Set()
    return { state, snapshot:()=>state, subscribe:listener=>{listeners.add(listener);return ()=>listeners.delete(listener)},
      send:command=>{if(command.type === "draft")state.draft=command.text}, end:()=>{for(const listener of listeners)listener(null)} }
  }
  const navigate = async url => {selected.forEach(callback=>callback({url}));await tick()}
  return {surface,handle,navigate,page,opened,document:window.document}
}

test("navigation keeps the subject and explicitly invokes the same tray for the new page", async () => {
  const h=setup(), runs=[]
  const release=h.page.registerPageAction({id:"addon:research/translate",label:"Translate",icon:"language",surfaces:["button"],tray:"translation",converses:true,appliesTo:()=>true,run:(page,mode)=>{runs.push({page,mode});return true}})
  try {
    h.surface.open(h.handle("translation"))
    await h.navigate("https://example.test/b")
    assert.equal(document.querySelector(".addon_panel_subject").href,"https://example.test/a")
    assert.equal(document.querySelector(".addon_panel_relationship"),null)
    assert.equal(document.querySelector("#left_panel").getAttribute("data-addon-story-matched"),"false")
    assert.equal(document.querySelector("#addon_panel_title").textContent,"Research tools · Translation")
    assert.ok(document.querySelector("#addon_menu_btn .icon--language"))
    const buttons=Array.from(document.querySelectorAll(".addon_panel_context button"))
    buttons.find(button=>button.textContent === "Use current page").click()
    assert.deepEqual(runs,[{page:{href:"https://example.test/b",title:"Beta"},mode:"panel"}])
    buttons.find(button=>button.textContent === "Open article").click()
    assert.deepEqual(h.opened,[["https://example.test/a","current"]])
    await h.navigate("https://example.test/comments")
    assert.equal(document.querySelector(".addon_panel_context button").textContent,"Open article")
    await h.navigate("once-reader://https/example.test/a")
    assert.equal(document.querySelectorAll(".addon_panel_context button").length,0)
  } finally {release()}
})

test("replacing and closing preserve a pending draft; different trays stay accessible", async () => {
  const h=setup(), summary=h.handle(), translation=h.handle("translation")
  h.surface.open(summary)
  const input=document.querySelector("textarea")
  input.value="Keep this draft"
  input.dispatchEvent(new Event("input"))
  h.surface.open(translation)
  assert.equal(summary.state.draft,"Keep this draft")
  assert.equal(document.querySelectorAll('select[aria-label="Recent conversations"] option:not([value=""])').length,2)
  h.surface.open(summary)
  assert.equal(document.querySelector("textarea").value,"Keep this draft")
  document.querySelector("textarea").value="Newest words"
  document.querySelector("textarea").dispatchEvent(new Event("input"))
  document.querySelector('[data-testid="addon-panel-close"]').click()
  assert.equal(summary.state.draft,"Newest words")
  h.surface.open(summary)
  assert.equal(document.querySelector("textarea").value,"Newest words")
  await tick()
})

test("a queued reset cannot close a different replacement conversation", async () => {
  const h=setup(), first=h.handle(), second=h.handle("translation")
  h.surface.open(first)
  first.end()
  h.surface.open(second)
  await tick()
  assert.match(document.querySelector("#addon_panel_title").textContent,/Translation/)
  second.end()
  await tick()
  assert.equal(document.querySelector("#addon_panel"),null)
})

test("placement is a host capability and reader wrappers retain source identity", () => {
  const h=setup()
  h.page.setConversationPlacementAvailable(false)
  assert.equal(h.page.canChooseConversationPlacement(),false)
  h.page.setConversationPlacementAvailable(true)
  assert.equal(h.page.canChooseConversationPlacement(),true)
  assert.equal(h.page.pageSourceUrl("about:reader?url=https%3A%2F%2Fexample.test%2Fa"),"https://example.test/a")
})

test("only the conversation's own mirrored story is shown, without a duplicate subject heading", async () => {
  const h=setup()
  const row=document.createElement("story-item")
  row.dataset.href="https://example.test/a"
  document.querySelector("#selected_container").append(row)
  h.surface.open(h.handle())
  await h.navigate("https://example.test/a")
  const matched=()=>document.querySelector("#left_panel").getAttribute("data-addon-story-matched")
  assert.equal(matched(),"true")
  assert.equal(document.querySelector(".addon_panel_context").hidden,true)
  await h.navigate("https://example.test/b")
  assert.equal(matched(),"false", "hide even the stale Alpha row as soon as navigation changes")
  assert.equal(document.querySelector(".addon_panel_context").hidden,false)
  assert.equal(row.dataset.href,"https://example.test/a", "the global browser mirror is not rewritten")
  row.dataset.href="https://example.test/b"
  h.surface.open(h.handle("summary","https://example.test/b"))
  await tick()
  assert.equal(matched(),"true")
  document.body.dataset.electronStoryPosition="browser"
  await tick()
  assert.equal(matched(),"false")
  assert.equal(document.querySelector(".addon_panel_context").hidden,false)
})
