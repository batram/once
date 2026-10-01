const assert = require("node:assert/strict")
const test = require("node:test")
const { renderingIterations } = require("../../e2e/electron/native-rendering/iterations")

test("local rendering runs retain every calibration pair", () => {
  assert.deepEqual(renderingIterations(undefined), [0, 1, 2])
})

test("the three CI jobs partition the local calibration repetitions", () => {
  const partitions = ["0", "1", "2"].map(renderingIterations)
  assert.deepEqual(partitions, [[0], [1], [2]])
  assert.deepEqual(partitions.flat(), renderingIterations(undefined))
})

test("invalid rendering selections fail instead of omitting calibration", () => {
  for (const value of ["", "-1", "3", "all", "0,1", "1.0", " 1", "1 "]) {
    assert.throws(() => renderingIterations(value), /must be 0, 1, or 2/)
  }
})
