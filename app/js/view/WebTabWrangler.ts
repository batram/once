export { WebTabWrangler }

class WebTabWrangler {
  el: HTMLElement
  tabs: any[]

  constructor() {
    this.tabs = []
  }

  init(el: HTMLElement) {
    this.el = el
  }

  static isValidWCID(id: any) {
    if (typeof id != "number") {
      id = parseInt(id)
      if (isNaN(id) || id < 0) {
        console.error("unusable id", id)
        return false
      }
    }

    return
  }

  addTab(wc_id: number) {
    if (!wc_id) {
      console.error("can't add tab with incomplete information")
      return
    }
    let existing_tab = this.tab_el_from_id(wc_id)
    if (existing_tab) {
      this.mark_tab_active(existing_tab)
    } else {
      let tab_content = document.querySelector("#tab_content")
      if (tab_content) {
        this.new_webtab(tab_content, wc_id)
      } else {
        console.error("failed to find tab_content to attach tabs")
        return
      }
    }
  }

  tab_el_from_id(wc_id: number) {
    return document.querySelector<HTMLElement>(`.tab[data-wc_id="${wc_id}"]`)
  }

  mark_tab_active(existing_tab: HTMLElement) {}
  new_webtab(tab_content: Element, wc_id: number) {}
}
