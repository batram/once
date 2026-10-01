// Each CI job runs one complete positive/negative pair. Local runs retain all
// three repetitions; reject typos rather than silently dropping coverage.
function renderingIterations(value) {
  if (value === undefined) return [0, 1, 2]
  if (!/^[012]$/.test(value)) {
    throw new Error("ONCE_RENDERING_ITERATION must be 0, 1, or 2")
  }
  return [Number(value)]
}

module.exports = { renderingIterations }
