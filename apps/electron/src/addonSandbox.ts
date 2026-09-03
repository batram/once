// Entry for the add-on sandbox page: the runtime and nothing else. It runs on
// an opaque origin inside a sandboxed frame with no preload and no bridge.
import { startSandboxRuntime } from "@once/ui-web/addons/sandboxRuntime"

startSandboxRuntime(window)
