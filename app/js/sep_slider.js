module.exports = {
  init_slider,
}

function init_slider() {
  let percent = get_slider_percent()
  left_panel.style.width = 100 - percent + "%"
  content.style.width = percent + "%"

  //resize on border
  function resize(e) {
    e.preventDefault()
    percent = ((window.innerWidth - e.x) / window.innerWidth) * 100
    left_panel.style.width = 100 - percent + "%"
    content.style.width = percent + "%"
    save_slider_percent(percent)
  }

  sep_slider.addEventListener("mousedown", (e) => {
    e.preventDefault()
    document.getElementById("foverlay").style.display = "block"
    document.body.style.cursor = "w-resize"
    document.addEventListener("mousemove", resize)
  })

  document.addEventListener("mouseup", () => {
    document.getElementById("foverlay").style.display = "none"
    document.body.style.cursor = ""
    document.removeEventListener("mousemove", resize)
  })
}

function save_slider_percent(p) {
  localStorage.setItem("slider_percent", p)
}

function get_slider_percent() {
  let slider_percent = localStorage.getItem("slider_percent")
  if (slider_percent == null) {
    slider_percent = 50
  }
  return slider_percent
}
