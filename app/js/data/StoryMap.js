const onChange = require("on-change")
const { Story } = require("./Story")

let s_map = {}

const story_map = onChange(s_map, function (path, value, previousValue, name) {
  console.log("change", path, value, previousValue, name)
  if (path.length != 0) {
    if (typeof this[path[0]] == "object") {
      if( name && this[path[0]] instanceof Story){
        console.log("story change", name)
      }

      const event = new CustomEvent("change", {
        detail: {
          story: story_map.get(path[0]),
          path: path,
          value: value,
          previousValue: previousValue,
          name: name,
        },
      })
      let story_els = document.querySelectorAll(
        `.story[data-href="${path[0]}"]`
      )
      story_els.forEach((story_el) => {
        story_el.dispatchEvent(event)
      })
      document.body.dispatchEvent(event)
    }
  }
})

story_map.set = (x, y) => {
  story_map[x] = y
  return story_map[x]
}

story_map.get = (x) => {
  return story_map[x]
}

story_map.has = (x) => {
  return story_map.hasOwnProperty(x)
}

story_map.clear = () => {
  for (let i in story_map) {
    if (typeof story_map[i] != "function") {
      delete story_map[i]
    }
  }
}

module.exports = {
  set: story_map.set,
  get: story_map.get,
  has: story_map.has,
  clear: story_map.clear,
}
