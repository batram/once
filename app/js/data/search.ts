const stroy_loader = require("../data/StoryLoader")
const menu = require("../view/menu")
import { Story } from "../data/Story"

export { init_search, search_stories }

let enabled_global_search = [search_hn]

function init_search() {
  let searchfield = document.querySelector<HTMLInputElement>("#searchfield")

  window.addEventListener("keyup", (e) => {
    //CTRL + F
    if (e.key == "f" && e.ctrlKey) {
      searchfield.focus()
    }
  })

  searchfield.addEventListener("input", (e) => {
    search_stories(searchfield.value)
  })

  let search_scope = document.querySelector<HTMLInputElement>("#search_scope")
  search_scope.addEventListener("change", (e) => {
    if (searchfield.value != "") {
      search_stories(searchfield.value)
    }
  })

  searchfield.addEventListener("keyup", (e) => {
    if (e.keyCode === 27) {
      //ESC
      searchfield.value = ""
      search_stories(searchfield.value)
    } else if (e.keyCode === 13) {
      //ENTER
      search_stories(searchfield.value)
    }
  })

  let cancel_search_btn = document.querySelector<HTMLElement>(
    "#cancel_search_btn"
  )
  cancel_search_btn.onclick = (x) => {
    searchfield.value = ""
    search_stories("")
  }
}

function search_stories(needle: string) {
  let story_container = document.querySelector<HTMLElement>("#stories")
  let global_search_results = document.querySelector<HTMLElement>(
    "#global_search_results"
  )
  let cancel_search_btn = document.querySelector<HTMLElement>(
    "#cancel_search_btn"
  )
  let search_scope = document.querySelector<HTMLInputElement>("#search_scope")

  story_container.classList.remove("show_filtered")
  story_container.style.display = "flex"
  global_search_results.style.display = "none"

  if (needle && needle != "") {
    cancel_search_btn.style.visibility = "visible"

    if (search_scope.value == "global") {
      global_search_results.style.display = "flex"
      story_container.style.display = "none"
      global_search_results.innerHTML = ""
      enabled_global_search.forEach((fun) => {
        fun(needle)
      })

      return
    }

    story_container.classList.add("show_stored_star")
  } else {
    cancel_search_btn.style.visibility = "hidden"
    story_container.classList.remove("show_stored_star")
  }

  let specialk: Record<string, Function> = {
    "[ALL]": () => {
      document.querySelector<HTMLInputElement>("#searchfield").value = ""
      search_stories("")
    },
    "[filtered]": () => {
      story_container.classList.add("show_filtered")
      document.querySelectorAll(".story").forEach((x) => {
        x.classList.remove("nomatch")
        if (!x.classList.contains("filtered")) {
          x.classList.add("nomatch")
        }
      })
    },
    "[stared]": () => {
      document.querySelectorAll(".story").forEach((x) => {
        x.classList.add("nomatch")
        if (x.classList.contains("stared")) {
          x.classList.remove("nomatch")
        }
      })
    },
    "[new]": () => {
      document.querySelectorAll(".story").forEach((x) => {
        x.classList.add("nomatch")
        if (!x.classList.contains("read")) {
          x.classList.remove("nomatch")
        }
      })
    },
  }

  if (specialk.hasOwnProperty(needle)) {
    specialk[needle]()
    return
  }

  document.querySelectorAll<HTMLElement>(".story").forEach((x) => {
    if (
      !(
        x.dataset.title.toLowerCase().includes(needle.toLowerCase()) ||
        x.dataset.href.toLowerCase().includes(needle.toLowerCase()) ||
        x.dataset.type.toLowerCase().includes(needle.toLowerCase())
      )
    ) {
      x.classList.add("nomatch")
    } else {
      x.classList.remove("nomatch")
    }
  })

  require("../view/StoryList").sort_stories()
}

function search_hn(needle: string) {
  fetch(
    "https://hn.algolia.com/api/v1/search_by_date?tags=story&restrictSearchableAttributes=url,title&query=" +
      encodeURIComponent(needle)
  ).then((x) => {
    if (x.ok) {
      x.json().then(async (json_response) => {
        let searchfield = document.querySelector<HTMLInputElement>(
          "#searchfield"
        )

        if (searchfield.value != needle) {
          //search changed bail
          return
        }
        let search_stories = json_response.hits.map((result: any) => {
          //add the tag if we have not ingested stories from HN yet
          let type = "HN"
          let colors = ["rgba(255, 102, 0, 0.56)", "white"]
          menu.add_tag(type, colors)

          let curl = "https://news.ycombinator.com/item?id=" + result.objectID

          let timestamp = Date.parse(result.created_at)

          return {
            type: "HN",
            search_result: needle,
            href: result.url || curl,
            title: result.title,
            comment_url: curl,
            timestamp: timestamp,
            sources: [{ type: "HN", comment_url: curl, timestamp: timestamp }],
          }
        })

        let estories = await stroy_loader.enhance_stories(search_stories, false)

        estories.forEach((story: Story) => {
          require("../view/StoryList").add(story, "global_search_results")
        })

        require("../view/StoryList").sort_stories("global_search_results")
      })
    }
  })
}

function search_lobsters_ddg(needle: string) {
  fetch(
    "https://html.duckduckgo.com/html/?q=site:lobste.rs/s/%20" +
      encodeURIComponent(needle)
  ).then((x) => {
    if (x.ok) {
      x.text().then(async (val) => {
        let searchfield = document.querySelector<HTMLInputElement>(
          "#searchfield"
        )
        if (searchfield.value != needle) {
          //search changed bail
          return
        }

        //TODO: think about it
      })
    }
  })
}
