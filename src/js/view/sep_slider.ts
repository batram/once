export { init_slider, collapse_left, expand_left }

function init_slider() {
  reset_position()

  document.querySelectorAll<HTMLElement>(".collapse").forEach((x) => {
    x.onclick = collapse_left
  })
  //resize on border
  function resize(event: MouseEvent) {
    event.preventDefault()
    let percent = ((window.innerWidth - event.x) / window.innerWidth) * 100

    let left_panel = document.querySelector<HTMLElement>("#left_panel")

    left_panel.style.width = 100 - percent + "%"
    let right_panel = document.querySelector<HTMLElement>("#right_panel")
    if (right_panel) {
      right_panel.style.width = percent + "%"
    }
    save_slider_percent(percent)
  }

  let sep_slider = document.querySelector("#sep_slider")

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

function reset_position() {
  let percent: number = get_slider_percent()
  let left_panel = document.querySelector<HTMLElement>("#left_panel")
  left_panel.style.width = 100 - percent + "%"
  let right_panel = document.querySelector<HTMLElement>("#right_panel")
  if (right_panel) {
    right_panel.style.width = percent + "%"
  }
}

function collapse_left() {
  let right_panel = document.querySelector<HTMLElement>("#right_panel")
  right_panel.style.width = "100%"

  let menu = document.querySelector<HTMLElement>("#menu")
  menu.classList.add("collapse")
  let left_panel = document.querySelector<HTMLElement>("#left_panel")
  left_panel.style.width = "0%"
  left_panel.style.minWidth = "28px"
}

function expand_left() {
  let right_panel = document.querySelector<HTMLElement>("#right_panel")
  right_panel.style.width = ""

  let menu = document.querySelector("#menu")
  menu.classList.remove("collapse")
  let left_panel = document.querySelector<HTMLElement>("#left_panel")
  left_panel.style.width = ""
  left_panel.style.minWidth = ""
  reset_position()
}

function save_slider_percent(p: number) {
  localStorage.setItem("slider_percent", p.toString())
}

function get_slider_percent(): number {
  let slider_percent = localStorage.getItem("slider_percent")
  if (slider_percent == null) {
    slider_percent = "50"
  }
  return parseInt(slider_percent)
}
