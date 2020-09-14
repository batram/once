const onChange = require("on-change")

class Story {
  constructor(type, href, title, comment_url, timestamp, filter = "") {
    this.type = type
    this.href = href
    this.title = title

    //TODO: class source or add complete stories as sources?
    this.sources = [
      {
        type: type,
        comment_url: comment_url,
        timestamp: timestamp,
      },
    ]
    this.comment_url = comment_url
    this.timestamp = timestamp
    this.filter = filter
  }

  static from_obj(story) {
    let xstory = new Story()
    for (let i in story) {
      xstory[i] = story[i]
    }
    if (!xstory.sources || xstory.sources.length == 0) {
      xstory.sources = [
        {
          type: xstory.type,
          comment_url: xstory.comment_url,
          timestamp: xstory.timestamp,
        },
      ]
    }
    return xstory
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
    this.add_to_readlist()
  }

  clone() {
    let cloned = new Story()
    for (let i in this) {
      try {
        cloned[i] = onChange.target(this[i])
      } catch (e) {
        cloned[i] = null
      }
    }

    return cloned
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

  has_or_get(story_el, prop, func) {
    if (this.hasOwnProperty(prop)) {
      if (this[prop]) {
        story_el.classList.add(prop)
      }
      func(story_el, this)
    } else {
      if (typeof this["is_" + prop] == "function") {
        this["is_" + prop]().then((x) => {
          if (x) {
            story_el.classList.add(prop)
          }
          func(story_el, this)
        })
      }
    }
  }

  async is_read() {
    const readlist = await settings.get_readlist()

    if (!this.hasOwnProperty("read")) {
      const readlist = await settings.get_readlist()
      this.read = readlist.includes(this.href)
    }

    return this.read
  }

  async is_stared() {
    if (!this.hasOwnProperty("stared")) {
      const starlist = await settings.get_starlist()
      this.stared = starlist.hasOwnProperty(this.href)
    }

    return this.stared
  }

  static compare(a, b) {
    //sort by read first and then timestamp
    if (a.read && !b.read) {
      return 1
    } else if (!a.read && b.read) {
      return -1
    } else if ((a.read && b.read) || (!a.read && !b.read)) {
      if (a.timestamp > b.timestamp) return -1
      if (a.timestamp < b.timestamp) return 1
      return 0
    }
    if (a.timestamp > b.timestamp) return -1
    if (a.timestamp < b.timestamp) return 1
    return 0
  }
}

module.exports = { Story }
