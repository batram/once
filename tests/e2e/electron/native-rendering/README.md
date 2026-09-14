# Native tab frame regression

On Electron 45.0.0-alpha.6, reparenting a WebContentsView with Chromium's
NativeViewHostManagesLayers enabled can leave the page incorrectly occluded.
Once disables that feature and keeps views attached during tab activation.
This suite tests the real built Once coordinator, renderer bridge and native
views without connecting Playwright or DevTools to the content pages.

## Run

On Windows, `npm run test:electron:rendering` builds the app and runs three
fresh workaround-on / workaround-off pairs. After an existing package build,
use `npm run test:electron:rendering:run`. Both CI and release workflows run
the latter after the existing Electron E2E package step.

The test opens small topmost windows. For unattended local runs use the repository's
hidden-desktop workflow and redirect the runner output to a file. Keep
ONCE_ELECTRON_TEST_BACKGROUND at 0: an off-screen window is not equivalent to
a normally positioned window on a private desktop. The runner sets this
explicitly and uses disposable user profiles, leaving normal Once data alone.
Windows are positioned before their pages load; after shell initialization
they stay above unrelated applications. The test checks that no test window
fully covers the measured content region. An unlocked, suitably sized display
and a healthy Electron GPU process are required. GPU or renderer crashes are
recorded and rejected, including startup GPU failures followed by fallback.
The private desktop on the development machine showed such GPU failures;
clean-GPU calibration therefore also needs a suitable interactive test desktop.

The test loads `.webpack/<arch>/main/index.js` with the project's Electron
binary, just as the existing E2E harness does. It tests the built application,
not the installed executable or Squirrel packaging. Reports record the exact
bundle SHA-256 and Electron/Chromium versions.

## What makes the result meaningful

* No Playwright renderer attachment. Playwright 1.59.1 enables focus emulation,
  which Chromium implements with a capturer that can keep a page visible.
* Every sample rejects a captured page or disabled background throttling.
* Process-health checks reject crashed child processes; the negative control
  cannot count a GPU crash as a tab regression.
* An inactive tab must become hidden and stop animation frames before the
  scenario proceeds. This checks the observer itself.
* A canvas paints a frame counter. Each operation must preserve the same
  in-memory token and produce increasing animation-frame counts over three
  observation intervals after a settling period. No resize, focus repair,
  screenshot or capturePage call occurs during those intervals.
* Activation, same-window reorder, detach, return and source-window closure
  are exercised repeatedly. A previously activated inactive tab also moves
  into a populated window through the renderer's synthetic DOM drop handler.
* The negative control must pass startup, initial rendering and observer
  calibration, then fail specifically on frame production at detach. A crash,
  timeout, reload, captured page or unrelated assertion is not an accepted
  negative control. If both configurations pass, calibration fails.

All three pairs must succeed; there are no retries that erase a failed sample.
Detailed observations and application logs live in
`artifacts/native-rendering/{workaround,native}-<iteration>/` (outside
Playwright's automatically cleared `test-results` directory).
`summary.json` identifies the attempts belonging to the latest run. Each pair
must use identical bundle hashes and runtime versions. Set
ONCE_RENDERING_SCREENSHOT=1 on the interactive desktop to capture the failing
tab rectangle and its native window owner **after** the verdict. This uses
Windows screen pixels, not a page capture, and does not participate in the
pass/fail decision.
The `native-*` report status `failed` with `TAB_FRAME_STALLED` at `detach-0`
is the expected negative-control result, not a failing suite.

This is an automated regression for the demonstrated frame-starvation bug.
It does not certify final OS-composited pixels or native pointer drag-and-drop.
The synthetic DOM drop tests application routing, not Windows' drag loop.

## Electron upgrades

Keep the same Electron version in both arms. The test-only
ONCE_ELECTRON_TEST_NATIVE_LAYERS=1 bypass is honored only when
ONCE_ELECTRON_TEST_USER_DATA is also set. Normal launches keep the workaround.
If upstream fixes native stacking, the negative control should stop failing;
investigate that calibration failure before removing the workaround and
updating this expectation. Do not silently skip it or downgrade Electron.

Source pointers:

* `ui/views/controls/native/native_view_host_aura.cc`: compare
  AttachNativeView's ReorderNativeViews with AddedToWidget's stacking.
* `content/browser/devtools/protocol/emulation_handler.cc`:
  SetFocusEmulationEnabled increments the capturer count with stay_hidden=false.
* Installed `playwright-core/lib/server/chromium/crPage.js`: focus emulation
  is enabled during page initialization.
