function read_story(href) {
  let readlist = localStorage.getItem("readlist")
  try {
    readlist = JSON.parse(readlist)
  } catch (e) {
    readlist = []
  }
  return readlist.includes(href)
}

function add_story(story) {
  story = filters.filter_story(story)

  let stories_container = document.querySelector("#stories")
  let new_story = document.createElement("div")
  new_story.classList.add("story")
  if (read_story(story.href)) {
    new_story.classList.add("read")
  }

  let link = document.createElement("a")
  link.href = story.href
  link.target = "frams"
  let title = document.createElement("h2")
  title.innerText = story.title
  new_story.dataset.title = story.title

  let info = document.createElement("div")
  let type = document.createElement("p")
  new_story.dataset.type = "[" + story.type + "]"
  type.innerText = "[" + story.type + "]"
  type.style.backgroundColor = story.colors[0]
  type.style.color = story.colors[1]
  type.style.display = "inline-block"
  info.appendChild(type)

  new_story.dataset.timestamp = story.timestamp
  info.appendChild(document.createTextNode("  " + story.time_str + "  "))

  new_story.dataset.hostname = link.hostname
  info.appendChild(document.createTextNode(" (" + link.hostname + ")"))

  let og_link = document.createElement("a")
  og_link.innerText = " [OG] "
  og_link.href = story.href
  og_link.target = "frams"
  info.appendChild(og_link)

  //comments
  let comments_link = document.createElement("a")
  comments_link.innerText = " [comments] "
  comments_link.href = story.comment_url
  comments_link.target = "frams"
  info.appendChild(comments_link)

  title.appendChild(info)
  link.appendChild(title)

  let data = document.createElement("div")
  data.classList.add("data")

  data.appendChild(link)
  new_story.appendChild(data)

  let filter_btn = document.createElement("div")
  filter_btn.classList.add("btn")
  filter_btn.classList.add("filter_btn")
  filter_btn.innerText = "filter"
  if (story.filtered) {
    new_story.classList.add("filtered")
    filter_btn.innerText = "filtered:\n" + story.filter
    filter_btn.style.borderColor = "red"
  }

  filter_btn.onclick = (x) => {
    filters.show_filter_dialog(x, story)
  }
  new_story.appendChild(filter_btn)

  let read_btn = document.createElement("div")
  read_btn.classList.add("btn")
  read_btn.classList.add("read_btn")
  if (!new_story.classList.contains("read")) {
    read_btn.title = "mark as read"
  } else {
    read_btn.title = "mark as unread"
  }
  read_btn.innerText = "read"
  read_btn.addEventListener(
    "click",
    (x) => {
      if (!new_story.classList.contains("read")) {
        new_story.classList.add("read")
        mark_as_read(story.href)
      } else {
        new_story.classList.remove("read")
        mark_as_unread(story.href)
      }
      x.preventDefault()
      x.stopPropagation()
      sort_stories()

      return false
    },
    false
  )
  new_story.appendChild(read_btn)

  new_story.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault()
      stupidMenu.target = story
      stupidMenu.rightClickPosition = {
        x: e.x,
        y: e.y,
      }
      menu.popup({
        window: remote.getCurrentWindow(),
      })
    },
    false
  )

  new_story.addEventListener(
    "click",
    (e) => {
      document.querySelectorAll(".story").forEach((x) => {
        x.classList.remove("selected")
      })
      new_story.classList.add("selected")
      sort_stories()
      if (!new_story.classList.contains("read")) {
        new_story.classList.add("read")
        mark_as_read(story.href)
      }
    },
    false
  )

  stories_container.appendChild(new_story)
}

function mark_as_read(href) {
  let readlist = localStorage.getItem("readlist")
  try {
    readlist = JSON.parse(readlist)
  } catch (e) {
    readlist = []
  }
  readlist.push(href)
  readlist = readlist.filter((v, i, a) => a.indexOf(v) === i)
  localStorage.setItem("readlist", JSON.stringify(readlist))
}

function mark_as_unread(href) {
  let readlist = localStorage.getItem("readlist")
  try {
    readlist = JSON.parse(readlist)
  } catch (e) {
    readlist = []
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
        })
      }
    })
  })
}
load()

reload_btn.onclick = (x) => {
  document.querySelectorAll(".story").forEach((x) => {
    x.outerHTML = ""
  })
  load()
}
