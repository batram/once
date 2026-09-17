# Plan: Linux Electron releases

Created 2026-09-17. Status: release implementation and packaging proof complete;
real-desktop validation remains.

## Outcome and decisions

Ship two x64 Linux artifacts on every tagged release:

- **Debian package (`.deb`)** as the primary install. Ubuntu/Debian users get a
  desktop entry, icon, declared runtime dependencies, and a conventional
  `/usr/bin/once` launcher. This covers the largest practical desktop-Linux
  audience with Forge's maintained `@electron-forge/maker-deb`.
- **Portable ZIP** as the distribution-neutral fallback. It has no package-manager
  integration or dependency resolution, but works for unsupported distributions
  after extraction and is also useful for diagnosis.

Do not add RPM in the first release: it adds another system toolchain and an
untested package contract without broadening coverage as much as the portable
ZIP. Do not add AppImage yet: `@reforged/maker-appimage` is outside the existing
Forge maker family and was not needed to prove a useful two-format release. It
can be reconsidered after `.deb` and ZIP have passed real-desktop testing.

Linux updates remain manual. `update-electron-app` and the Squirrel feed stay
Windows-only; Linux continues to use the existing version-row release lookup and
GitHub link in `apps/electron/src/ManualReleaseCheck.ts`.

## Work

1. [x] **Add the Linux makers and dependency.** Pin
   `@electron-forge/maker-deb` to the other Forge packages' `7.11.2`, retain the
   Windows makers, and make the Debian package name/binary explicit. The `bin`
   option is required: without it, the maker derives `@once/electron` from the
   scoped npm package and cannot find Packager's `once` executable.

   ```diff
   diff --git a/apps/electron/package.json b/apps/electron/package.json
   --- a/apps/electron/package.json
   +++ b/apps/electron/package.json
   @@
      "devDependencies": {
        "@electron-forge/cli": "7.11.2",
   +    "@electron-forge/maker-deb": "7.11.2",
        "@electron-forge/maker-squirrel": "7.11.2",
   diff --git a/apps/electron/forge.config.js b/apps/electron/forge.config.js
   --- a/apps/electron/forge.config.js
   +++ b/apps/electron/forge.config.js
   @@
        {
          name: "@electron-forge/maker-zip",
   -      platforms: ["win32"]
   +      platforms: ["win32", "linux"]
   +    },
   +    {
   +      name: "@electron-forge/maker-deb",
   +      platforms: ["linux"],
   +      config: {
   +        options: {
   +          name: isDevChannel ? "once-dev" : "once",
   +          productName: isDevChannel ? "Once Dev" : "Once",
   +          genericName: "Feed Reader",
   +          bin: isDevChannel ? "once-dev" : "once",
   +          maintainer: "Once contributors",
   +          icon: linuxWindowIcon,
   +          categories: ["Utility"]
   +        }
   +      }
        }
   ```

2. [x] **Prove packaging locally.** This was run on Arch Linux x86-64 with
   Node 24.21.0/npm 12.0.2 and Electron `45.0.0-alpha.6`. The host had
   `/sbin/fakeroot` but no `dpkg`, `zip`, or `xvfb-run`. Root package installation
   was unavailable, so exact Arch `dpkg 1.23.7-1` and `zip 3.0-14` packages were
   downloaded and extracted under `/tmp/once-dpkg`; the system was not modified.

   Commands and outcomes (exit codes are exact):

   | Command | Exit | Result |
   | --- | ---: | --- |
   | `npm ci` | 1 | `EALLOWGIT`: npm disabled the locked Git dependency `@electron/node-gyp`. |
   | `npm ci --allow-git=all` | 226 | `EROFS` creating `/home/mjb/.npm/_cacache/tmp/...`. |
   | `npm ci --allow-git=all --cache /tmp/once-npm-cache` | 0 | 2,774 packages installed; required approved network access. |
   | `npm install --workspace @once/electron --save-dev --save-exact @electron-forge/maker-deb@7.11.2 --allow-git=all --cache /tmp/once-npm-cache` | 0 | Added the Debian maker at the existing Forge version. |
   | `npm run make:electron` | 1 | The npm 12 install-script policy had left `node_modules/node/bin/node` absent (`spawnSync ... ENOENT`). |
   | `npm install-scripts approve node esbuild sharp leveldown` | 0 | Approved only already-locked build dependencies; the Node package's nested installer was then run from `node_modules/node`. |
   | `node installArchSpecificPackage.js` (cwd `node_modules/node`) | 0 | Installed the locked Linux Node binary. |
   | `npm run make:electron` | 1 | Forge reached maker resolution and reported missing `dpkg, fakeroot`. |
   | `pacman -Sy --noconfirm dpkg` | 1 | Correctly failed because this environment does not grant root. |
   | `curl -fL https://frankfurt.mirror.pkgbuild.com/extra/os/x86_64/dpkg-1.23.7-1-x86_64.pkg.tar.zst -o /tmp/once-pacman-cache/dpkg.pkg.tar.zst` followed by local `bsdtar` extraction | 0 | Supplied temporary `dpkg`/`dpkg-deb`. |
   | `env PATH=/tmp/once-dpkg/usr/bin:/sbin:/bin:/usr/bin:/usr/local/bin npm run make:electron` | 1 | Packaging completed, then ZIP making failed with `spawn zip ENOENT`. |
   | Download/extract `zip-3.0-14-x86_64.pkg.tar.zst` into `/tmp/once-dpkg` | 0 | Supplied temporary Info-ZIP. |
   | Same `env PATH=... npm run make:electron` | 1 | Both makers started; Debian maker exposed the scoped-name bug: expected `Once-linux-x64/@once/electron`. |
   | Same command after adding `bin`, then after adding the final explicit name/product fields above | 0, 0 | ZIP and Debian distributables completed. |

   Final artifacts from the recommended configuration:

   - `apps/electron/out/make/deb/x64/once_0.3.0_amd64.deb` — 98,704,080 bytes;
   - `apps/electron/out/make/zip/linux/x64/Once-linux-x64-0.3.0.zip` —
     131,551,394 bytes.

   `dpkg-deb --info` reported package `once`, version `0.3.0`, architecture
   `amd64`, and normal Electron desktop dependencies. `dpkg-deb --contents` and
   `bsdtar -tf` proved both formats contain `resources/app.asar`,
   `resources/icon.png`, and the uBlock Origin and Violentmonkey manifests.
   The unpacked resources measured 18 MiB and 2.2 MiB respectively. The Debian
   package creates `/usr/bin/once -> ../lib/once/once`.

   A stale 808,283-byte temporary file named `ziVCOkQ9` remained under the ZIP
   output after an earlier interrupted make. A fresh CI checkout will not have
   it, upload globs exclude it, and verification should require known artifacts
   rather than publishing arbitrary files from the make tree.

   No Xvfb binary was available. A sandboxed launch failed before startup with
   Chromium `sandbox_host_linux.cc:41` and exit 133. Outside the sandbox, this
   bounded diagnostic command produced Chromium startup logs and exit 139:

   ```bash
   ELECTRON_ENABLE_LOGGING=1 timeout 20s \
     apps/electron/out/Once-linux-x64/once \
     --no-sandbox --disable-setuid-sandbox --disable-gpu --headless \
     --ozone-platform=headless --enable-logging=stderr --v=1
   ```

   It reached browser, zygote, GPU, network utility, and renderer process startup,
   detected KDE6 password storage, and initialized the Once profile before the
   headless-only environment segfaulted. This proves the packaged executable loads
   and starts application processes, but is not a successful UI smoke; that remains
   a real-desktop release gate below.

3. [x] **Add an Ubuntu release job.** Ubuntu already provides a native environment
   for the target audience. Install the maker tools explicitly, run the existing
   make command, verify Linux-specific names, and upload only the two publishable
   files. Gate signing and publication on this job. Download the artifact into the
   aggregate release directory before the final verifier runs.

   ```diff
   diff --git a/.github/workflows/release.yml b/.github/workflows/release.yml
   --- a/.github/workflows/release.yml
   +++ b/.github/workflows/release.yml
   @@
      electron:
        name: Electron for Windows
   @@
            if-no-files-found: error
   +
   +  electron-linux:
   +    name: Electron for Linux
   +    runs-on: ubuntu-latest
   +    env:
   +      RELEASE_TAG: ${{ github.event.inputs.tag || github.ref_name }}
   +      ONCE_RELEASE_BUILD: "1"
   +    steps:
   +      - uses: actions/checkout@v7
   +        with:
   +          ref: ${{ env.RELEASE_TAG }}
   +      - uses: actions/setup-node@v6
   +        with:
   +          node-version: 24
   +          cache: npm
   +      - run: sudo apt-get update && sudo apt-get install -y dpkg fakeroot zip
   +      - run: npm ci
   +      - run: npm run verify:release-version -- "$RELEASE_TAG"
   +      - run: npm run make:electron
   +      - run: npm run verify:release-artifacts -- electron-linux apps/electron/out/make
   +      - uses: actions/upload-artifact@v7
   +        with:
   +          name: electron-linux
   +          path: |
   +            apps/electron/out/make/**/*.deb
   +            apps/electron/out/make/zip/linux/**/*.zip
   +          if-no-files-found: error
   @@
      sign-firefox:
   -    needs: [extensions, electron]
   +    needs: [extensions, electron, electron-linux]
   @@
      release:
   -    needs: [sign-firefox, electron]
   +    needs: [sign-firefox, electron, electron-linux]
   @@
          - uses: actions/download-artifact@v8
            with:
              name: electron-windows
              path: release
   +      - uses: actions/download-artifact@v8
   +        with:
   +          name: electron-linux
   +          path: release
   ```

4. [x] **Make artifact verification platform-specific.** Preserve `electron` as
   the Windows target for compatibility (or rename it and update the current
   workflow together), add `electron-linux`, and make aggregate `release` require
   both sets. Match complete basenames so one platform's ZIP cannot satisfy the
   other platform's assertion.

   ```diff
   diff --git a/scripts/verify-release-artifacts.js b/scripts/verify-release-artifacts.js
   --- a/scripts/verify-release-artifacts.js
   +++ b/scripts/verify-release-artifacts.js
   @@
    } else if (target === "electron") {
      const files = walk(root)
      requireFiles(files, "Electron setup executable", (file) => file.endsWith(`-${version} Setup.exe`))
      requireFiles(files, "Electron full NuGet package", (file) => file.endsWith(`-${version}-full.nupkg`))
   -  requireFiles(files, "Electron ZIP", (file) => file.endsWith(`-${version}.zip`))
   +  requireFiles(files, "Windows Electron ZIP", (file) =>
   +    path.basename(file) === `Once-win32-x64-${version}.zip`)
      requireFiles(files, "Squirrel RELEASES metadata", (file) => path.basename(file) === "RELEASES")
   +} else if (target === "electron-linux") {
   +  const files = walk(root)
   +  requireFiles(files, "Linux Debian package", (file) =>
   +    path.basename(file) === `once_${version}_amd64.deb`)
   +  requireFiles(files, "Linux Electron ZIP", (file) =>
   +    path.basename(file) === `Once-linux-x64-${version}.zip`)
    } else if (target === "release") {
   @@
   -  requireFiles(files, "Electron ZIP", (file) => file.endsWith(`-${version}.zip`))
   +  requireFiles(files, "Windows Electron ZIP", (file) =>
   +    path.basename(file) === `Once-win32-x64-${version}.zip`)
   +  requireFiles(files, "Linux Debian package", (file) =>
   +    path.basename(file) === `once_${version}_amd64.deb`)
   +  requireFiles(files, "Linux Electron ZIP", (file) =>
   +    path.basename(file) === `Once-linux-x64-${version}.zip`)
   @@
   -  throw new Error("Target must be extensions, electron, or release")
   +  throw new Error("Target must be extensions, electron, electron-linux, or release")
   ```

   Add verifier fixtures/tests for missing Debian, missing Linux ZIP, a wrongly
   versioned artifact, and the case where only the Windows ZIP is present.

5. [x] **Update release documentation.** Change the opening product description
   from “Electron desktop app (Windows)” to “Electron desktop app (Windows and
   Linux)”. In “What CI checks and produces”, list five jobs and add “Electron
   for Linux (Ubuntu) — verify version, make `.deb` and portable ZIP, verify and
   upload both.” Replace the expected-name paragraph with separate Windows and
   Linux lists. State plainly that Windows Squirrel installs self-update, while
   Linux `.deb` and ZIP installs use Settings → **Check latest release** and must
   be downloaded/installed manually.

   ```diff
   diff --git a/docs/RELEASING.md b/docs/RELEASING.md
   --- a/docs/RELEASING.md
   +++ b/docs/RELEASING.md
   @@
   -app (Windows), and the **Firefox** and **Chrome** side-panel extensions.
   +app (Windows and Linux), and the **Firefox** and **Chrome** side-panel extensions.
   @@
   -The workflow runs four jobs:
   +The workflow runs five jobs:
   @@
    - **Electron for Windows** — `npm ci`, verify version, run Electron unit/e2e
      tests, and `make:electron` (Squirrel installer, NuGet package, ZIP).
   +- **Electron for Linux** (Ubuntu) — `npm ci`, verify version, and
   +  `make:electron` (`.deb` and portable ZIP).
   @@
   -  `*-X.Y.Z Setup.exe`, `*-X.Y.Z-full.nupkg`, `*-X.Y.Z.zip`, and `RELEASES`.
   +  Windows `*-X.Y.Z Setup.exe`, `*-X.Y.Z-full.nupkg`,
   +  `Once-win32-x64-X.Y.Z.zip`, and `RELEASES`; Linux
   +  `once_X.Y.Z_amd64.deb` and `Once-linux-x64-X.Y.Z.zip`.
   +
   +Squirrel automatic updates are Windows-only. Linux packages use the existing
   +manual release check in Settings and link to the GitHub release for download.
   ```

6. [x] **Use the existing Linux icon.** Keep
   `packages/ui-web/public/static/imgs/icons/icon.png`, added by commit
   `c0951d08` (“Add Linux Electron app icon”), as both the BrowserWindow resource
   and Debian desktop icon. Confirm the installed desktop entry resolves it at
   normal launcher sizes. Do not derive the Linux icon from the Windows `.ico`.

7. [ ] **Validate on real desktops before publishing.** Test the `.deb` on the
   current Ubuntu LTS and the ZIP on at least one non-Debian desktop. Record distro,
   desktop/session (X11 or Wayland), GPU, and install/uninstall behavior. Required
   checks:

   - first launch and relaunch, application menu entry/icon, single-instance
     behavior, profile persistence, and manual release-check link;
   - keychain storage with Secret Service available, locked, and absent, including
     the documented safe fallback and clear user-facing failure behavior;
   - Web Speech voices and playback through Speech Dispatcher, proving the
     `enable-speech-dispatcher` switch in `apps/electron/src/main.ts` works with a
     configured backend and fails intelligibly without one;
   - native title bar, window controls, draggable regions, resize/maximize/fullscreen,
     multi-monitor movement, and scale factors other than 100%;
   - GPU acceleration and video/rendering on representative Intel/AMD hardware,
     plus a software-rendering diagnostic run; inspect logs for crashes or repeated
     compositor errors;
   - bundled uBlock Origin and Violentmonkey load from `resources/extensions`, and
     core story/reader flows work from both `.deb` and ZIP installs.

8. [ ] **Release gradually.** Publish the first Linux artifacts as explicitly
   experimental in release notes, inspect downloads and issue reports for one
   patch cycle, then remove that label after both formats pass the desktop matrix.
   Keep Windows Squirrel asset names and updater behavior unchanged.

## Desktop acceptance evidence

Partial real-desktop validation ran on 2026-09-17 in an Arch Linux KDE Plasma
X11 session over XRDP at 2560×1440 and 100% scale. Both published archives were
extracted independently and their executables launched from the extracted
locations with isolated profiles. Each mapped a focused `once-electron` X11
window and started the browser, GPU, network, renderer, uBlock Origin, and
Violentmonkey processes. The Debian launcher, icon, and resources were present;
the run caught and fixed a desktop-entry default that exposed `@once/electron`
as `GenericName`, which is now explicitly `Feed Reader`.

The live packaged UI showed version 0.3.0, `Check latest release`, the manual
GitHub link, and the Windows-only automatic-update explanation. Its real GitHub
API check reported v0.3.0 current and updated the link to the tagged release.
Both bundled extensions reported enabled/applied. Fullscreen expanded from the
restored 1312×971 window to 2560×1440 and restored to the exact prior geometry.
CSS inspection confirmed the titlebar/dropzone are `drag` while tabs and the new
tab button are `no-drag`; XTest pointer injection did not move the window, so a
human drag and native window-button pass is still required.

KDE Secret Service (`org.freedesktop.secrets`/KWallet) was available. A temporary
secret round-tripped and was deleted through the packaged bridge without a
plaintext copy. With the session bus deliberately absent, Electron selected its
own basic Linux password backend: the temporary value still round-tripped as an
encrypted blob in a mode-0600 file, so this did not exercise Once's plaintext
fallback and must not be represented as equivalent to an OS keyring. A locked
wallet still needs manual validation.

The `enable-speech-dispatcher` path exposed 14,805 local eSpeak voices, including
English (America), proving Chromium discovered Speech Dispatcher. Both standalone
`spd-say -w` and a Web Speech utterance failed to complete before their timeouts
on the XRDP PulseAudio-on-PipeWire sink, so audible TTS remains unaccepted.

Graphics were Mesa llvmpipe (OpenGL 4.6, direct rendering reported but not
accelerated); the container exposed no `/dev/dri`, VA-API render node, or DRI3.
The app remained stable with software compositing, but physical Intel/AMD GPU
coverage and Wayland remain outstanding.

## Non-goals

- Linux automatic/self-update, repository hosting, apt signing, Snap, Flatpak,
  RPM, or AppImage in the first release.
- ARM64 Linux artifacts until CI builds and a real ARM64 desktop validate them.
- macOS packaging or signing.
- Claiming the headless container launch as a UI, keychain, TTS, title-bar, or GPU
  acceptance test.

## Exit criteria

- Tagged CI builds and verifies Windows, Linux, Chrome, and signed Firefox assets,
  and publication cannot proceed when either Linux artifact is absent or stale.
- A clean `ubuntu-latest` job produces exactly the versioned `.deb` and Linux ZIP.
- Both artifacts contain `app.asar`, the Linux icon, and both extension bundles.
- The real-desktop matrix above is recorded and passes without a release-blocking
  crash or data-loss issue.
- Documentation accurately distinguishes Windows automatic updates from Linux's
  existing manual release check.
