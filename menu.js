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
      x.style.display = "block"
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

    tag.onclick = (x) => {
      open_panel('stories')
      document.querySelector("#searchfield").value = "[" + type + "]"
      search.search_stories("[" + type + "]")
    }

    document.querySelector("#menu").appendChild(tag)
  }
}

//Add special tags for search
add_tag("ALL", ["", ""])
add_tag("filtered", ["", ""])
add_tag("new", ["", ""])
