// Entry of `lite-runtime.js`, the broker page: finds the channel Java
// injected (`window.onceLite`) and the files interface (`window.onceLiteFiles`),
// starts the broker and says hello so Java can send `lite.start`.

import { LiteBroker } from "./broker"
import { JavaChannel, MessagePort, installNativeTimers } from "./javaChannel"
import { FilesInterface } from "./liteFiles"
import { BROKER_CHANNEL, FILES_INTERFACE } from "./protocol"

declare global {
  interface Window {
    onceLite?: MessagePort
    onceLiteFiles?: FilesInterface
    onceLiteBroker?: LiteBroker
  }
}

function start(): void {
  const port = window[BROKER_CHANNEL as "onceLite"]
  const files = window[FILES_INTERFACE as "onceLiteFiles"]
  if (!port || !files) {
    console.error("Once Lite broker: the Java channel is missing; this page only works inside the app")
    return
  }
  const broker = new LiteBroker(port, files)
  installNativeTimers(broker.channel)
  window.onceLiteBroker = broker
  broker.channel.event("broker.hello")
}

export type { JavaChannel }
start()
