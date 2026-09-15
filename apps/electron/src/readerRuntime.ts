import { installReaderTts } from "@once/ui-web/reader/readerTts"

installReaderTts({
  wafli: { wasmUrl: "once-reader://runtime/wafli-module.wasm" }
})
