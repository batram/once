import { WebTab } from "./webtab"
import * as fullscreen from "./fullscreen"

document.addEventListener("DOMContentLoaded", async (_e) => {
  new WebTab()
  fullscreen.render_listeners()
})
