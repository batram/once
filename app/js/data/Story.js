const onChange = require("on-change")

class Story {
  constructor(type, href, title, comment_url, timestamp) {
    this.type = type
    this.href = href
    this.title = title
    this.comment_url = comment_url
    this.timestamp = timestamp
  }

  remove_from_readlist() {
    settings.get_readlist().then((readlist) => {
      const index = readlist.indexOf(this.href)
      if (index > -1) {
        readlist.splice(index, 1)
      }
      settings.save_readlist(readlist, console.log)
    })
  }

  add_to_readlist() {
    settings.get_readlist().then((readlist) => {
      readlist.push(onChange.target(this.href))
      readlist = readlist.filter((v, i, a) => a.indexOf(v) === i)
      settings.save_readlist(readlist, console.log)
    })
  }

  mark_as_read() {
    this.read = true
  }

  clone() {
    let cloned = new Story()
    for (let i in this) {
      cloned[i] = this[i]
    }

    return i
  }

  star() {
    this.stared = true

    settings.get_starlist().then((starlist) => {
      starlist[this.href] = onChange.target(this)
      settings.save_starlist(starlist, console.log)
    })
  }

  unstar() {
    this.stared = false

    settings.get_starlist().then((starlist) => {
      if (starlist.hasOwnProperty(this.href)) {
        delete starlist[this.href]
        settings.save_starlist(starlist, console.log)
      }
    })
  }

  has_or_get(story_el, prop, func, check) {
    if (this.hasOwnProperty(prop)) {
      if (this[prop]) {
        story_el.classList.add(prop)
      }
      func(story_el, this)
    } else {
      check(this.href).then((x) => {
        if (x) {
          story_el.classList.add(prop)
        }
        func(story_el, this)
      })
    }
  }

  open_in_webview(e) {
    e.preventDefault()
    e.stopPropagation()

    let href = this.href

    if (e.target.href) {
      href = e.target.href
    }

    web_control.open_in_webview(href)
    this.mark_as_read()

    return false
  }
}

module.exports = { Story }
