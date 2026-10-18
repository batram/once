const path = require("node:path")
const webpack = require("webpack")
webpack({
  mode: "production", devtool: false,
  entry: path.resolve(__dirname, "native-storage-probe-entry.js"),
  output: { path: path.resolve(__dirname, "../artifacts/performance/native-storage"), filename: "probe.js" },
  resolve: { fallback: { stream: require.resolve("stream-browserify"), util: require.resolve("util/"), events: require.resolve("events/"), assert: require.resolve("assert/") } },
  plugins: [new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"], process: "process/browser.js" })]
}, (error, stats) => {
  if (error || stats.hasErrors()) { console.error(error || stats.toString({ all: false, errors: true })); process.exitCode = 1 }
  else console.log("Built isolated native storage probe")
})
