// Entry for the add-on sandbox page on mobile: the runtime and nothing else.
// The page is a static asset beside the app, loaded in a sandboxed frame, so
// it has an opaque origin, its own policy, and no bridge to anything.
import { startSandboxRuntime } from "@once/ui-web/addons/sandboxRuntime"

startSandboxRuntime(window)
