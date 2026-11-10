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
      // Springing home from an earlier release is an animation, and while it
      // runs it overrides the transform the moves above set. Sample once the
      // row has none left, rather than after a delay it might outlast.
      await Promise.all(
        row
          .getAnimations()
          .filter((animation) =>
            Number.isFinite(animation.effect?.getComputedTiming().endTime))
          .map((animation) => animation.finished.catch(() => undefined))
      )
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

// Holds a single move at `distance` until stage two arms and returns every
// distinct state the revealed side went through on the way. The lock-in runs on
// timers, so its phases are recorded as they happen: sampling them at
// wall-clock offsets misses a phase whenever the worker is busy. The touch is
// left down for the caller to release or cancel.
async function holdSwipeUntilArmed(story, distance) {
  return story.evaluate(
    async (row, distance) => {
      const rect = row.getBoundingClientRect()
      const y = rect.top + rect.height / 2
      const startX = distance > 0 ? rect.left + 40 : rect.right - 40
      const touch = (x) =>
        new Touch({ identifier: 11, target: row, clientX: x, clientY: y })
      const fire = (type, x) => {
        row.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: [touch(x)],
            changedTouches: [touch(x)]
          })
        )
      }
      const side = distance > 0 ? ".swipe_left" : ".swipe_right"
      const states = []
      // Returns whether stage two has armed.
      const record = () => {
        const revealed = document.querySelector(`.bb_slide ${side}`)
        const state = {
          action: revealed?.dataset.action,
          lock: revealed?.dataset.lock,
          phase: revealed?.dataset.lockPhase,
          primary:
            revealed?.querySelector(".swipe_action_primary")?.textContent,
          secondary:
            revealed?.querySelector(".swipe_action_secondary")?.textContent,
          handoffDuration:
            revealed?.style.getPropertyValue("--swipe-handoff-duration")
        }
        const last = states[states.length - 1]
        if (!last || Object.keys(state).some((key) => state[key] !== last[key])) {
          states.push(state)
        }
        return state.lock === "armed"
      }
      fire("touchstart", startX)
      fire("touchmove", startX + distance)
      const layer = document.querySelector(".bb_slide")
      if (!layer) throw new Error("The swipe revealed nothing")
      if (record()) return states
      await new Promise((resolve, reject) => {
        // Each timer of the lock rewrites the layer in one task, so a callback
        // sees one whole state and never half of an update.
        const observer = new MutationObserver(() => {
          if (!record()) return
          observer.disconnect()
          clearTimeout(expiry)
          resolve()
        })
        // Far beyond the longest lock-in the settings allow (500ms).
        const expiry = setTimeout(() => {
          observer.disconnect()
          reject(new Error(
            `Stage two never armed: ${JSON.stringify(states)}`
          ))
        }, 5000)
        observer.observe(layer, {
          subtree: true,
          attributes: true,
          childList: true,
          characterData: true
        })
      })
      return states
    },
    distance
  )
}

function translateX(transform) {
  if (!transform || transform === "none") return 0
  // computed transforms come back as a matrix; tx is the 5th component
  const parts = transform.match(/matrix\(([^)]+)\)/)
  return parts ? Math.round(Number(parts[1].split(",")[4])) : 0
}

module.exports = { dragStory, holdSwipeUntilArmed, translateX }
