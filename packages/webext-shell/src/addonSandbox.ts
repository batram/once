// Entry for the add-on sandbox page in the extension builds: the runtime and
// nothing else. On Chrome the page is a manifest `sandbox` page with its own
// policy; Firefox uses MV2 with blob modules permitted by its extension CSP.
// Both hosts keep the frame opaque with sandbox="allow-scripts".
import { startSandboxRuntime } from "@once/ui-web/addons/sandboxRuntime"

startSandboxRuntime(window)
