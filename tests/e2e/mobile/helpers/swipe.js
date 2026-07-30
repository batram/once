// Drives the touch path (not the mouse path) so the axis lock is exercised too.
// `moves` are the fractions of `distance` the finger is sampled at — a real
// flick reports far fewer, coarser moves than a slow drag.
async function dragStory(
  story,
  distance,
  { release = true, moves = [0.2, 0.5, 0.8, 1] } = {}
) {
  return story.evaluate(
    async (row, options) => {
      const rect = row.getBoundingClientRect()
      const y = rect.top + rect.height / 2
      const startX = rect.left + 40
      const touch = (x) =>
        new Touch({ identifier: 3, target: row, clientX: x, clientY: y })
      const fire = (type, x) => {
        row.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: type === "touchend" ? [] : [touch(x)],
            changedTouches: [touch(x)]
          })
        )
      }
      fire("touchstart", startX)
      for (const fraction of options.moves) {
        fire("touchmove", startX + options.distance * fraction)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      // Sample only after the transform has stopped changing. Waiting on the
      // rendered state avoids assuming the 90ms snap transition will finish
      // within a fixed wall-clock delay on a loaded CI worker.
      await new Promise((resolve) => {
        const deadline = performance.now() + 750
        let previous = getComputedStyle(row).transform
        let stableFrames = 0
        const sample = () => {
          const current = getComputedStyle(row).transform
          stableFrames = current === previous ? stableFrames + 1 : 0
          previous = current
          if (stableFrames >= 3 || performance.now() >= deadline) {
            resolve()
            return
          }
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
      const revealedLabel = document.querySelector(
        options.distance > 0
          ? ".bb_slide .swipe_left"
          : ".bb_slide .swipe_right"
      )
      const state = {
        transform: getComputedStyle(row).transform,
        label:
          document.querySelector(".bb_slide .swipe_left .swipe_action_primary")
            ?.innerText || "",
        labelRight:
          document.querySelector(".bb_slide .swipe_right .swipe_action_primary")
            ?.innerText || "",
        secondaryLabel:
          revealedLabel?.querySelector(".swipe_action_secondary")?.innerText || "",
        labelWeight: revealedLabel
          ? getComputedStyle(
            revealedLabel.querySelector(".swipe_action_primary") || revealedLabel
          ).fontWeight
          : "",
        action:
          document.querySelector('.bb_slide [data-stage="1"], .bb_slide [data-stage="2"]')
            ?.dataset.action || "none"
      }
      if (options.release) {
        document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
      }
      return state
    },
    { distance, release, moves }
  )
}

// Holds a single move at `distance` and reports the revealed surface after each
// of `waits`, which is how the fast-mode lock-in phases are observed.
async function sampleSwipePhases(story, distance, waits) {
  return story.evaluate(
    async (row, options) => {
      const rect = row.getBoundingClientRect()
      const y = rect.top + rect.height / 2
      const startX = options.distance > 0 ? rect.left + 40 : rect.right - 40
      const touch = (x) =>
        new Touch({ identifier: 11, target: row, clientX: x, clientY: y })
      const fire = (type, x) => {
        row.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: type === "touchend" ? [] : [touch(x)],
            changedTouches: [touch(x)]
          })
        )
      }
      fire("touchstart", startX)
      fire("touchmove", startX + options.distance)
      const snapshots = []
      for (const wait of options.waits) {
        await new Promise((resolve) => setTimeout(resolve, wait))
        const side = options.distance > 0 ? ".swipe_left" : ".swipe_right"
        const revealed = document.querySelector(`.bb_slide ${side}`)
        snapshots.push({
          action: revealed?.dataset.action,
          lock: revealed?.dataset.lock,
          phase: revealed?.dataset.lockPhase,
          primary:
            revealed?.querySelector(".swipe_action_primary")?.textContent,
          secondary:
            revealed?.querySelector(".swipe_action_secondary")?.textContent,
          handoffDuration:
            revealed?.style.getPropertyValue("--swipe-handoff-duration")
        })
      }
      document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
      return snapshots
    },
    { distance, waits }
  )
}

function translateX(transform) {
  if (!transform || transform === "none") return 0
  // computed transforms come back as a matrix; tx is the 5th component
  const parts = transform.match(/matrix\(([^)]+)\)/)
  return parts ? Math.round(Number(parts[1].split(",")[4])) : 0
}

module.exports = { dragStory, sampleSwipePhases, translateX }
