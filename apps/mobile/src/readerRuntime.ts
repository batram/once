import { installReaderTts } from "@once/ui-web/reader/readerTts"
import { installReaderTtsPolyfill } from "./readerTtsPolyfill"

installReaderTtsPolyfill(window, { force: true })
installReaderTts()
