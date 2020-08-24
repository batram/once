module.exports = {
  load,
  reload,
}

function is_story_read(href) {
  let readlist = localStorage.getItem("readlist")
  try {
    readlist = JSON.parse(readlist)
  } finally {
    if (!Array.isArray(readlist)) {
      readlist = []
    }
  }
  return readlist.includes(href)
}

function add_story(story) {
  story = filters.filter_story(story)

  //check if we already have story with same URL
  let og_story_el = document.querySelector(
    '.story[data-href="' + story.href + '"] .data'
  )

  if (og_story_el) {
    //merge story by adding info block, ignore title
    og_story_el.appendChild(info_block(story))
    return
  }

  let stories_container = document.querySelector("#stories")
  let new_story_el = document.createElement("div")
  new_story_el.classList.add("story")
  if (is_story_read(story.href)) {
    new_story_el.classList.add("read")
  }

  new_story_el.dataset.title = story.title
  new_story_el.dataset.href = story.href
  new_story_el.dataset.hostname = story.hostname
  new_story_el.dataset.timestamp = story.timestamp
  new_story_el.dataset.type = "[" + story.type + "]"

  let title_line = document.createElement("div")
  title_line.classList.add("title_line")

  let link = document.createElement("a")
  link.href = story.href
  link.classList.add("title")
  link.innerText = story.title
  title_line.appendChild(link)

  let hostname = document.createElement("p")
  hostname.classList.add("hostname")
  hostname.innerText = " (" + link.hostname + ") "
  title_line.appendChild(hostname)

  let info = info_block(story)

  let data = document.createElement("div")
  document.createElement("data")
  data.classList.add("data")

  data.appendChild(title_line)
  data.appendChild(info)

  new_story_el.appendChild(data)

  let filter_btn = document.createElement("div")
  filter_btn.classList.add("btn")
  filter_btn.classList.add("filter_btn")
  let filter_icon = document.createElement("img")
  filter_icon.src = "imgs/filter.svg"
  filter_btn.appendChild(filter_icon)
  filter_btn.title = "filter"

  if (story.filtered) {
    filter_btn.title = "filtered"
    new_story_el.classList.add("filtered")
    let dinp = document.createElement("input")
    dinp.type = "text"
    dinp.value = story.filter
    dinp.disabled = true
    dinp.style.cursor = "pointer"
    filter_btn.prepend(dinp)
    filter_btn.style.borderColor = "red"
  }

  filter_btn.onclick = (x) => {
    filters.show_filter_dialog(x, filter_btn, story)
  }

  new_story_el.appendChild(filter_btn)

  let read_btn = document.createElement("div")
  read_btn.classList.add("btn")
  read_btn.classList.add("read_btn")
  let read_icon = document.createElement("img")
  if (!new_story_el.classList.contains("read")) {
    read_btn.title = "mark as read"
    read_icon.src = "imgs/read.svg"
  } else {
    read_btn.title = "mark as unread"
    read_icon.src = "imgs/unread.svg"
  }

  read_btn.appendChild(read_icon)
  read_btn.addEventListener(
    "click",
    (x) => {
      if (!new_story_el.classList.contains("read")) {
        new_story_el.classList.add("read")
        read_btn.title = "mark as unread"
        read_icon.src = "imgs/unread.svg"
        mark_as_read(story.href)
      } else {
        new_story_el.classList.remove("read")
        read_btn.title = "mark as read"
        read_icon.src = "imgs/read.svg"
        mark_as_unread(story.href)
      }
      x.preventDefault()
      x.stopPropagation()
      sort_stories()

      return false
    },
    false
  )
  new_story_el.appendChild(read_btn)

  new_story_el.addEventListener(
    "contextmenu",
    (e) => {
      contextmenu.story_menu(e, story)
    },
    false
  )

  link.addEventListener(
    "click",
    (e) => {
      open_in_webview(e)

      document.querySelectorAll(".story").forEach((x) => {
        x.classList.remove("selected")
      })
      new_story_el.classList.add("selected")
      sort_stories()
      if (!new_story_el.classList.contains("read")) {
        new_story_el.classList.add("read")
        mark_as_read(story.href)
      }
    },
    false
  )

  stories_container.appendChild(new_story_el)
}

function open_in_webview(e) {
  e.preventDefault()
  e.stopPropagation()

  document.querySelector("#frams").loadURL(e.target.href)
}

function info_block(story) {
  let info = document.createElement("div")
  info.classList.add("info")
  let type = document.createElement("p")
  type.classList.add("tag")
  type.innerText = story.type
  type.style.backgroundColor = story.colors[0]
  type.style.borderColor = story.colors[1]
  type.style.color = story.colors[1]
  info.appendChild(type)

  let og_link = document.createElement("a")
  og_link.innerText = " [OG] "
  og_link.href = story.href
  og_link.addEventListener("click", open_in_webview)
  info.appendChild(og_link)

  //comments
  let comments_link = document.createElement("a")
  comments_link.innerText = " [comments] "
  comments_link.href = story.comment_url
  comments_link.addEventListener("click", open_in_webview)
  info.appendChild(comments_link)

  info.appendChild(document.createTextNode("  " + story.time_str + "  "))

  return info
}

function mark_as_read(href) {
  let readlist = localStorage.getItem("readlist")
  try {
    readlist = JSON.parse(readlist)
  } finally {
    if (!Array.isArray(readlist)) {
      readlist = []
    }
  }
  readlist.push(href)
  readlist = readlist.filter((v, i, a) => a.indexOf(v) === i)
  localStorage.setItem("readlist", JSON.stringify(readlist))
}

function mark_as_unread(href) {
  let readlist = localStorage.getItem("readlist")
  try {
    readlist = JSON.parse(readlist)
  } finally {
    if (!Array.isArray(readlist)) {
      readlist = []
    }
  }
  const index = readlist.indexOf(href)
  if (index > -1) {
    readlist.splice(index, 1)
  }

  localStorage.setItem("readlist", JSON.stringify(readlist))
}

function sort_stories() {
  //sort by timestamp
  let storted = Array.from(document.querySelectorAll(".story")).sort((a, b) => {
    var a_time = a.dataset.timestamp
    var b_time = b.dataset.timestamp
    var a_read = a.classList.contains("read")
    var b_read = b.classList.contains("read")
    if (a_read && !b_read) {
      return 1
    } else if (!a_read && b_read) {
      return -1
    } else if ((a_read && b_read) || (!a_read && !b_read)) {
      if (a_time > b_time) return -1
      if (a_time < b_time) return 1
      return 0
    }
    if (a_time > b_time) return -1
    if (a_time < b_time) return 1
    return 0
  })

  storted.forEach((x) => {
    document.querySelector("#stories").appendChild(x)
  })
}

let urls = [
  "https://news.ycombinator.com/",
  "https://news.ycombinator.com/news?p=2",
  "https://news.ycombinator.com/news?p=3",
  "https://lobste.rs/",
  "https://old.reddit.com/r/netsec/.rss",
]

function load() {
  urls.forEach((url) => {
    fetch(url).then((x) => {
      if (x.ok) {
        x.text().then((val) => {
          let dom_parser = new DOMParser()
          let doc = dom_parser.parseFromString(val, "text/html")

          let stories = story_parser.parse(url, doc)

          stories.forEach((x) => {
            add_story(x)
          })

          sort_stories()
          search.search_stories(searchfield.value)
        })
      }
    })
  })
}

function reload() {
  document.querySelectorAll(".story").forEach((x) => {
    x.outerHTML = ""
  })
  load()
}

reload_btn.onclick = (x) => {
  reload()
}
