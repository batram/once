// Entry for the add-on sandbox page in the extension builds: the runtime and
// nothing else. On Chrome the page is a manifest `sandbox` page with its own
// policy; on Firefox the same page must be hosted on an origin Once does not
// own, because no page under an extension's origin may run third-party code.
import { startSandboxRuntime } from "@once/ui-web/addons/sandboxRuntime"

startSandboxRuntime(window)
