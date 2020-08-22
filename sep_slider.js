module.exports = {
  init_slider,
}

function init_slider() {
  //resize on border
  function resize(e) {
    e.preventDefault()
    resize_position = e.x
    let min_max = 20
    percent = Math.max(
      Math.min(
        ((window.innerWidth - e.x) / window.innerWidth) * 100,
        100 - min_max
      ),
      min_max
    )
    stories.style.width = 100 - percent + "%"
    sep_slider.style.left = 100 - percent + "%"
    content.style.width = percent + "%"
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
