module.exports = {
  init_search,
  search_stories,
}

function init_search() {
  window.addEventListener("keyup", (e) => {
    //CTRL + F
    if (e.key == "f" && e.ctrlKey) {
      searchfield.focus()
    }
  })

  searchfield.addEventListener("input", (e) => {
    search_stories(e.target.value)
  })

  searchfield.addEventListener("keyup", (e) => {
    if (e.keyCode === 27) {
      //ESC
      e.target.value = ""
      search_stories(e.target.value)
    } else if (e.keyCode === 13) {
      //ENTER
      //ipcRenderer.send("search-text", e.target.value)
      search_stories(e.target.value)
    }
  })

  cancel_search_btn.onclick = (x) => {
    searchfield.value = ""
    search_stories("")
  }
}

function search_stories(needle) {
  document.querySelector("#stories").classList.remove("show_filtered")
  if (needle && needle != "") {
    cancel_search_btn.style.visibility = "visible"
  } else {
    cancel_search_btn.style.visibility = "hidden"
  }

  let specialk = {
    "[ALL]": () => {
      document.querySelector("#searchfield").value = ""
      search_stories("")
    },
    "[filtered]": () => {
      document.querySelector("#stories").classList.add("show_filtered")
      document.querySelectorAll(".story").forEach((x) => {
        x.style.display = "none"
        if (x.classList.contains("filtered")) {
          x.style.display = ""
        }
      })
    },
    "[stared]": () => {
      document.querySelectorAll(".story").forEach((x) => {
        x.style.display = "none"
        if (x.classList.contains("stared")) {
          x.style.display = ""
        }
      })
    },
    "[new]": () => {
      document.querySelectorAll(".story").forEach((x) => {
        x.style.display = ""
        if (x.classList.contains("read")) {
          x.style.display = "none"
        }
      })
    },
  }

  if (specialk.hasOwnProperty(needle)) {
    specialk[needle]()
    return
  }

  document.querySelectorAll(".story").forEach((x) => {
    x.style.display = ""
    if (
      !(
        x.dataset.title.toLowerCase().includes(needle.toLowerCase()) ||
        x.dataset.hostname.toLowerCase().includes(needle.toLowerCase()) ||
        x.dataset.type.toLowerCase().includes(needle.toLowerCase())
      )
    ) {
      x.style.display = "none"
    }
  })
}
