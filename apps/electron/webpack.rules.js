const path = require("path")

module.exports = [
  {
    test: /\.html$/,
    include: path.resolve(__dirname, "src", "browser"),
    type: "asset/source"
  },
  {
    test: /\.tsx?$/,
    exclude: /node_modules/,
    use: {
      loader: "ts-loader",
      options: {
        configFile: path.resolve(__dirname, "tsconfig.json"),
        transpileOnly: true
      }
    }
  }
]
