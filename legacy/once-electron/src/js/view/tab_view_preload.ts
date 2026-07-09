import { WebTab } from "./WebTab"
import * as fullscreen from "./fullscreen"
import * as story_parser from "../data/parser"
import { URLRedirect } from "../data/URLRedirect"

URLRedirect.init()

document.addEventListener("DOMContentLoaded", async () => {
  new WebTab()
  story_parser.add_all_css_colors()
  fullscreen.render_listeners()
})
