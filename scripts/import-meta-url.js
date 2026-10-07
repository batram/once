// A bare `import.meta.url` is baked into a webpack bundle as the module's
// absolute build path (file:///C:/Users/<name>/...), which would ship the
// build machine's user name and layout in every app. zip.js (its worker base
// URI) and the wafli Emscripten glue (its script directory) read it, and
// both have it overridden in Once: workers are off and wafli is given
// `locateFile`. Defining it as the page's own URL, read at runtime, keeps
// them working without the path. Static `new URL("x", import.meta.url)`
// asset references are resolved by webpack's URL handling before this
// applies, wherever that handling is enabled.
const importMetaUrlDefine = { "import.meta.url": "self.location.href" }

module.exports = { importMetaUrlDefine }
