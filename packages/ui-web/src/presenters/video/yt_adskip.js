function adskippy_youtube(id) {
  let res = []
  try {
    try {
      res = JSON.parse(localStorage.getItem("skippies_" + id))
    } catch (e) {
      localStorage.setItem("skippies_" + id, "[]")
      res = []
    }
  } catch (e) {
    console.log(e)
  }

  if (res && res.length != 0) {
    skip_ads(res)
  } else {
    //add skip inline ads
    const url = "https://sponsor.ajay.app/api/skipSegments?videoID=" + id
    fetch(url).then((resp) => {
      if (resp.status == 200) {
        resp.text().then((val) => {
          try {
            localStorage.setItem("skippies_" + id, val)
          } catch (e) {
            console.log(e)
          }
          const res = JSON.parse(val)
          if (res.length != 0) {
            skip_ads(res)
          }
        })
      }
    })
  }
}

function skip_ads(skippies) {
  const player = window.player

  player.on("timeupdate", () => {
    skippies.forEach((skip) => {
      //jump start ad
      if (skip.segment[0] < 4) {
        player.currentTime(skip.segment[1] + 0.1)
      }

      if (!document.getElementById(skip.UUID)) {
        const dur = player.duration()
        const start_percent = (skip.segment[0] / dur) * 100
        const length_percent = ((skip.segment[1] - skip.segment[0]) / dur) * 100
        const skip_div = document.createElement("div")
        skip_div.id = skip.UUID
        skip_div.classList.add("vjs-load-progress")
        skip_div.style =
          "width: " +
          length_percent +
          "%; left: " +
          start_percent +
          "%; background: #ff000080;"
        document.querySelector(".vjs-progress-holder").appendChild(skip_div)
      }

      if (
        skip.category == "sponsor" &&
        player.currentTime() > skip.segment[0] - 0.7 &&
        player.currentTime() <= skip.segment[1]
      ) {
        player.currentTime(skip.segment[1] + 0.3)
      }
    })
  })
}
