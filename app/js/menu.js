module.exports = {
  add_tag,
}

document.querySelectorAll("#menu .sub").forEach((x) => {
  x.onclick = (e) => {
    open_panel(x.dataset.panel)
  }
})

function open_panel(panel) {
  document.querySelectorAll("#left_main .panel").forEach((x) => {
    if (x.dataset.panel != panel) {
      x.style.display = "none"
    } else {
      x.style.display = "flex"
    }
  })
}

function add_tag(type, colors) {
  if (!document.querySelector('#menu div[data-type="' + type + '"]')) {
    tag = document.createElement("div")
    tag.dataset.type = type
    tag.classList.add("btn")
    tag.classList.add("menu_btn")
    tag.classList.add("tag")
    tag.classList.add("tag")
    tag.innerText = "[" + type + "]"
    tag.style.backgroundColor = colors[0]
    tag.style.color = colors[1]

    if (colors && colors[0] != "") {
      console.log("dagf", colors)
      //inject css for story tags
      var style = document.createElement("style")
      style.classList.add("tag_style")
      style.type = "text/css"
      style.innerHTML = `
      .info[data-tag='${tag.innerText}'] .tag {
        background-color: ${colors[0]};
        border-color: ${colors[1]};
        color: ${colors[1]};
      }
      `
      document.head.append(style)
    }

    tag.onclick = (x) => {
      open_panel("stories")
      search_scope.value = "local"
      document.querySelector("#searchfield").value = "[" + type + "]"
      search.search_stories("[" + type + "]")
    }

    document.querySelector("#menu").appendChild(tag)
  }
}

//Add special tags for search
add_tag("ALL", ["", ""])
add_tag("filtered", ["", ""])
add_tag("stared", ["", ""])
add_tag("new", ["", ""])
