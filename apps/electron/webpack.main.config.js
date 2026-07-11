const webpack = require("webpack")
const rules = require("./webpack.rules")

module.exports = {
  entry: "./src/main.ts",
  module: { rules },
  resolve: {
    extensions: [".js", ".ts", ".jsx", ".tsx", ".css"]
  },
  plugins: [
    new webpack.DefinePlugin({
      __ONCE_BUILD_CHANNEL__: JSON.stringify(
        process.env.ONCE_BUILD_CHANNEL === "dev" ? "dev" : "release"
      )
    })
  ],
  devtool: "source-map"
}
