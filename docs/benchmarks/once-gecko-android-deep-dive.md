# Once Android GeckoView startup and memory deep dive — 2026-10-29

Commit `c3d9239d`, GeckoView `159.0.20261022150525`. Where the time and memory go when Once opens its first Gecko page, and what moves them. Harness, raw JSON and logs are in `artifacts/gecko-deep-dive/` (git-ignored; `harness/` has the scripts, `results/` the per-trial JSON).

## Setup

- **Emulator** (main work): Android 16 (API 36) arm64, 4 KB pages, 4 cores, 6 GB, on an M4 Pro host. Fresh profile (bridge, uBlock Origin, Violentmonkey; Dark Reader, SponsorBlock, Consent-O-Matic installed from AMO for the ablation). 4 KB pages match the phone; the stock Pixel_9 AVD uses 16 KB pages and was not used.
- **Samsung SM-G780G**, Android 13: the installed app with the real profile (read-only), plus a separate `com.zmarn.once.dev` install (fresh profile, removed afterwards).
- Method: `force-stop`, cold launch, 10 s settle, native `InAppBrowserSurface.open` on a local fixture over `adb reverse`, page-load beacon back to the host. Medians of 5 unless stated. Milestones come from logcat and CDP. Memory is `smaps_rollup`/`smaps` for the debuggable builds and `dumpsys meminfo <pid>` for the release build.
- Builds: the existing production-channel debug APK, and a **non-debuggable release** build of the same commit. The release build was built with `ALWAYS_INSPECTABLE` flipped to `true` temporarily so CDP works; the source change was reverted and is not in the tree. Remote debugging being on is the only difference from a shipped build.
- **Host noise incident**: a macOS root daemon (`searchpartyd`) sat at ~900 % CPU for about an hour and made emulator wall-clock times 10–20× slower with inflated guest CPU time. All numbers below were taken after it stopped (host load ≈ 1). Earlier runs were discarded. Memory numbers were unaffected.

## Headline findings

1. **An `adb install`ed Once is not dexopted (`status=run-from-apk`), on both devices, and that is the biggest single lever.** The dex files are deflated in the APK (AGP default because `minSdk` is 26), so ART inflates them into a private anonymous mapping (one `r--p` mapping, 40 MB for the debug build, ~35 MB for release) in **every** Gecko process (main, crashhelper, gpu, utility, each tab), and classes are verified at runtime. Fixes measured:

| Release build, emulator | Shell shown | Open → page loaded | Total PSS, tiny page | Total PSS, Wikipedia |
|---|---:|---:|---:|---:|
| as installed (deflated dex, run-from-apk) | 2.04 s | 2.65 s | 614 MB | 696 MB |
| `cmd package compile -m verify` | 1.29 s | 1.99 s | 477 MB | 531 MB |
| `speed-profile` / `speed` | 1.29 / 1.31 s | 2.15 / 2.05 s | – | – |
| dex **stored uncompressed**, still run-from-apk | 1.71 s | 1.71 s | 453 MB | 509 MB |
| stored dex + `verify` | 1.31 s | **1.23 s** | – | – |

   (Total PSS includes the shell WebView renderer. Stored dex was tested by repacking the release APK, no source change; `packaging { dex { useLegacyPackaging = false } }` in `app/build.gradle` is the build-side equivalent. APK grows ~22 MB.) `speed-profile`/`speed` buy nothing over `verify` on this path, and the packaged baseline profile has 3,095 rules and none for `org.mozilla.*`.
   Per process (release, tiny page, as installed → verify): crashhelper 42 → 7 MB, gpu 61 → 30, tab 99 → 67, main 292 → 253.
   Debuggable builds can never get past `verify`, and cost about 1 s more on open than release (3.0 s vs 1.99 s with `verify`). The phone's installed app is debuggable, so its daily numbers carry that penalty.

2. **Samsung cross-check (fresh dev package, debug build)** agrees: run-from-apk → `verify` gives shell shown 1.42 → 1.02 s, open → loaded ≈4.2 s → 1.58 s (only 2 of 5 as-installed trials produced a load beacon inside the watch window), and child-process PSS crashhelper 62 → 21, gpu 82 → 44, tab 129 → 84, utility 80 → 35 MB. The real app on the phone (as installed, real profile, run-from-apk) measured shell 1.33 s and open → loaded 2.16 s median (n=5, one 28 s outlier), so it is not simply as slow as the fresh dev install; unexplained, worth a repeat.

3. **Where the time goes** once compiled (release, `verify`, ≈2.0 s open → load; stored+verify run: ms after the `open` call):
   - Java setup → `GeckoRuntime.create` → parent Gecko `RUNNING`: ≈0.2 s (libs 21 ms, JNI ready +0.2 s).
   - gpu and content processes spawn right after; Java startup of a child is ≈0.1 s compiled but **1.4 s (debug) / 0.7 s (release) uncompiled**, in parallel for both children.
   - `about:blank` loaded +584 ms; first extension port connect +772 ms; ports released +837 ms; `open` resolves +1,051 ms (waits for filter and userscript settlement); fixture navigation starts +912 ms; load event +1,218 ms.
   - Gecko parent CPU during the first 1.5 s is dominated by the `Gecko` main thread (~430 ms) and, uncompiled, by ART `Jit thread pool` threads (≈400–500 ms each in main, crashhelper, gpu and tab).

4. **Process inventory and memory** (release, `verify`, emulator, tiny page / Wikipedia): shell WebView ≈ 125 MB in the main process plus ≈120–165 MB renderer; Gecko adds ≈128 MB to the main process (jemalloc ≈100 MB, libxul/omni pages ≈60 MB shared file-backed, JS GC heap ≈19 MB), a 67 → 114 MB content process, 30 MB gpu, 7 MB crashhelper, and a 21 MB utility process that appears on media pages. Total 477 / 531 MB, so the shell WebView is about as large as everything Gecko adds. With fission off a second tab still gets **its own content process** (≈58–94 MB each on a tiny page).

5. **Extensions** (release + `verify`, fresh profile, main-process PSS; extensions run in the parent because `EXTENSION_PROCESS=false`): none 215 MB; uBlock Origin +41; Violentmonkey +12; Dark Reader +18; SponsorBlock +11; Consent-O-Matic +10; all five 295 MB (+80). On a news page the content process grows 125 → 159 MB with all five. Open → load: 1.3 s with none, 2.2 s with uBlock+Violentmonkey (n=1 each). One run with only Violentmonkey disabled took 15.8 s to load, which looks like the userscript settlement barrier timing out (n=1, not investigated).

6. **Unexplained on the phone: the Gecko parent heap balloons with the real profile.** The installed app's main process (jemalloc) was 161 MB on the fixture, 286 MB on Wikipedia and **788 MB on theguardian.com** (main PSS 434 → 573 → 993 MB, total 1.56 GB with swap in use). The same five extensions on the emulator's fresh profile reached 286 MB main PSS on the same page, so the growth is profile- or phone-specific (filter lists, userscripts, Dark Reader site fixes, ad content), not extension count alone. It is consistent with the 2026-10-27 observation of ~1 GB. Finding the culprit needs per-extension ablation on the real profile; I did not toggle your extensions.

## Recommendations, by evidence

1. Store dex uncompressed in the APK (`useLegacyPackaging = false`) and have the Android deploy script run `cmd package compile -m verify -f <package>` after install. Together: −1.4 s open, −160 MB total PSS vs the as-installed state, on this emulator.
2. Benchmark and measure on non-debuggable builds; debug adds ~1 s and caps ART at `verify`.
3. Ablate extensions on the real phone profile to find what grows the parent heap; consider an extension process only after that, since it was 340 MB idle on 2026-10-27.
4. Investigate the 15 s settlement wait when Violentmonkey is disabled, and the 0.7 s between content-process ready and `open` resolving (extension port/settings settlement).
5. Decide if per-tab content processes are wanted: `dom.ipc.processCount` was not tested.

## Not measured

Play-Store-style cloud-profile installs, a non-debuggable build on the phone, battery/idle drain, `dom.ipc.processCount`, Gecko-internal profiler startup traces (prior notes cover those), real-profile ablation, and runs on a second emulator image. n=5 per cell; ranges are in the JSON. Emulator wall times are not phone times.

## Addendum: per-extension ablation on the Samsung's real profile

Each run: one extension disabled, fresh process, example.com then theguardian.com (45 s), main/Gecko-parent and content-process PSS from `smaps_rollup` (debuggable installed app, real profile). All five extensions were re-enabled afterwards and verified.

| Config | Main (tiny / news) | Content tab (tiny / news) | Total (tiny / news) |
|---|---:|---:|---:|
| all on (run 1) | 415 / 410 | 136 / 190 | 821 / 870 |
| all on (run 2) | 423 / 411 | 135 / 201 | 836 / 885 |
| − uBlock Origin | 300 / 298 | 84 / 172 | 657 / 744 |
| − Dark Reader | 399 / 394 | 60 / 131 | 737 / 800 |
| − Violentmonkey | 400 / 394 | 64 / 136 | 742 / 808 |
| − SponsorBlock | 415 / 392 | 139 / 202 | 830 / 866 |
| − Consent-O-Matic | 452 / 413 | 130 / 192 | 869 / 886 |

- uBlock Origin is the big parent-heap cost (≈115 MB). Dark Reader and Violentmonkey each cost ≈15 MB in the parent but ≈60–70 MB in the content process (content scripts, userscripts). SponsorBlock and Consent-O-Matic are within noise (≈±20 MB between identical runs).
- **The 788 MB parent heap did not reproduce.** Opening theguardian.com directly in a fresh process gave main ≈410 MB, twice. The earlier blow-up came from loading the fixture, Wikipedia and then the Guardian in one process, so it is accumulation across navigations in the parent (retained per-page extension state or caches), not one page or one extension. A navigation-sequence test with per-extension ablation is the next experiment.

### Navigation-sequence follow-up (same phone, real profile)

Six navigations in one process (example.com, Wikipedia ×3, theguardian.com ×2, 25 s each), one extension off per run, main / content-tab / total PSS in MB after the first and last page:

| Config | Main p1 → p6 | Tab p1 → p6 | Total p1 → p6 |
|---|---:|---:|---:|
| all on (a / b) | 417 → 404 / 429 → 399 | 135 → 256 / 138 → 287 | 828 → 1036 / 840 → 1058 |
| − uBlock Origin | 319 → 238 | 125 → 248 | 726 → 844 |
| − Dark Reader | 429 → 376 | 61 → 191 | 772 → 902 |
| − Violentmonkey | 419 → 389 | 97 → 145 | 772 → 890 |

The Gecko parent stayed flat at ≈400 MB across all six navigations, so the 788 MB heap seen earlier is **not** reproduced by navigation count either (0 of 17 runs). It remains a one-off; the untested suspects are a uBlock Origin filter-list update/compile or other background work in the parent during that run, or memory pressure on the phone at the time. Content-process growth is the steady cost: it reaches ≈250–290 MB after six pages with everything on, and Dark Reader alone accounts for ≈60–100 MB of it. All five extensions were restored to enabled and verified.

## Part 2: what is actually in the memory, and where startup CPU goes

Method: Gecko's own memory reporters (the data behind about:memory) pulled from every Gecko process through the Firefox remote-debugging socket (`nsIMemoryReporterManager.getReports`, parent-process console), joined with `smaps`. Zones and realms tagged `moz-extension://<uuid>` are attributed to their extension. Startup CPU comes from the Gecko profiler started with the process (`MOZ_PROFILER_STARTUP` via the debug config YAML, 1 ms, JS + native stacks, IPC, per-thread CPU), weighted by each sample's CPU delta. Emulator, debuggable build compiled `verify`, fresh profile with the bridge, uBlock Origin, Violentmonkey, Dark Reader, SponsorBlock and Consent-O-Matic, fixture then theguardian.com. Harness: `artifacts/gecko-deep-dive/harness/{rdp,memrep,memdeep,profgrab}.js`, `mr2.py`, `profcpu.py`.

### Gecko parent process (shares the app's main process), ≈340 MB PSS

| Layer | MB | What it is |
|---|---:|---|
| Capacitor shell (WebView browser side, ART, app dex) | ≈125 | present before Gecko starts |
| libxul code | 41 PSS (77 resident) | file-backed text pages touched at startup, shared with child processes, reclaimable |
| libxul relocations | 5.3 | private dirty, paid in every Gecko process |
| jemalloc mapping | 115 | 74.7 allocated + **28.5 freed but still resident (MADV_FREE; kernel takes it back under pressure)** + 12 partially-used size-class bins + 3.5 dirty cache + 1.4 bookkeeping |
| JS GC heap | 31 | extension and chrome JS objects |
| uBlock Origin WebAssembly memory | 9.9 | its trie engine (`wasm-reserved`) |

The ≈120 MB that Gecko accounts for itself, by owner:

| Owner | MB | Contents |
|---|---:|---|
| uBlock Origin | 43–44 | JS objects 27.5 (including the 9.9 MB WebAssembly heap), strings 4.8, shapes 2.9, GC slack 3.5, bytecode 1.8 |
| Dark Reader | 9.7 | JS objects 6.4 (site-fix indexes), strings 2.4 |
| Violentmonkey, Consent-O-Matic, SponsorBlock, bridge | 0.4–1.9 each | |
| Gecko heap-unclassified | 19–24 | native allocations no reporter claims |
| Safe Browsing prefix sets | 12.6 | 22 URL-classifier tables: Google phishing 9.0, tracking allowlists 3.0, rest small |
| Gecko's own JS (chrome scripts, bytecode) | 9.4 | |
| Startup cache and script preloader | 7.7–8.2 | |
| Other Gecko core | ≈6 | JS runtime, SQLite, GC slack |

`minimizeMemoryUsage` frees nothing measurable: it is live data, not garbage.

### Content process on the Guardian, 94 MB explicit (≈190 MB PSS)

- **Gecko core, 57 MB:** heap-unclassified 24, Gecko's own JS for actors and widgets 8, GC slack 5.5, layout 3.4.
- **The page itself, 21 MB:** layout/style 9.5, JS objects 4.9, DOM 3.4.
- **Consent-O-Matic content script, 13.9 MB, in every content process.** Dark Reader 1.1, uBlock Origin 0.6.
- The rest of the PSS is per-process overhead: libxul 50 MB file-backed, ART/dex ≈12 MB, relocations.

### GPU process

46–48 MB PSS with only **1.3 MB** of Gecko explicit memory: almost all of it is per-process overhead (libxul, ART, dex, relocations).

### Reduction options, measured

| Option | Effect | Cost / risk |
|---|---|---|
| `layers.gpu-process.enabled: false` | −37 MB total, startup unchanged in that run | a GPU or driver crash takes down the main process |
| uBlock Origin → uBO Lite | only −8 MB (36.6 vs 44 MB) | Gecko's declarativeNetRequest is JavaScript, so the rules become 19 MB of JS objects and 8.5 MB of strings anyway. Not worth it on Gecko. |
| No content blocker at all | −50 MB in the main process | — |
| Drop Consent-O-Matic | −14 MB in every content process | user's choice |
| `dom.ipc.processPrelaunch.enabled: true` | +≈110 MB (a spare content process plus parent growth) | removes the synchronous content-process wait below; the speed gain is unmeasured because emulator timing became unstable |
| Safe Browsing prefs off via YAML | **no effect**: all 22 tables still load | needs GeckoView `ContentBlocking.Settings` in `GeckoEngine` (untested); dropping phishing protection saves ~9 MB |
| `MOZ_CRASHREPORTER_DISABLE` | **no effect**: GeckoView 159 starts the crash helper unconditionally in `GeckoRuntime.init` | only removing the CrashHelper service from the manifest avoids it (untested; loses crash reports) |

### Where startup CPU goes (parent main thread, cold start to page loaded)

The profiler inflates absolute times: its own startup adds ≈2.5 s between LIBS_READY and JNI_READY. Treat these as proportions of ≈1.5 s of main-thread CPU:

- **Extension background scripts: ≈370 ms.** uBlock Origin 117 (selfie restore, filter index), Dark Reader 97 (`processSiteFixesConfigBlock`, `indexURLTemplateList`: it indexes its site-fix lists on every start), Violentmonkey 83, SponsorBlock 50, bridge 20.
- **Gecko's extension framework: ≈200 ms.** Schemas.sys.mjs API injection (`exportLazyProperty`, `injectInto`), ExtensionParent (`createBrowserElement`, `initWindowlessBrowser`), XPIDatabase, GeckoViewWebExtension. This scales with the number of extensions.
- **`storage.local` through IndexedDB: ≈255 ms.** 92 ms is `ExtensionStorageIDB.set`, the rest is IndexedDB completions. uBlock Origin keeps 7.4 MB in `storage.local`, almost all of it two copies of the URLhaus malware list (raw 3.3 MB and compiled 3.4 MB) that its updater rewrites. Consent-O-Matic keeps a 450 KB rule cache. Restarting extensions on their own caused no writes, so the cost is tied to the first engine start and list updates.
- **Gecko init (XRE) ≈170 ms.**
- **Synchronous wait for the first content process.** Creating the first remote browser (`browser-custom-element get loadContext → ContentParent::CreateBrowser → nsFrameLoader::TryRemoteBrowser`) blocks the parent main thread in `GeckoChildProcessHost::WaitUntilConnected` until the content process launches. This is the cost of disabling prelaunch: about 0.1–0.25 s in unprofiled logs, much longer under the profiler.
- **Content process:** `XRE_InitChildProcess` 105 ms CPU; content-script injection machinery (ExtensionContent, ExtensionCommon) ≈40 ms; Dark Reader's content script 32 ms per page.

### Caveat on emulator timing

The same configuration measured 0.7 s open → load in one hour and 7.5 s in the next, and 4× shifts happened between sessions. Host load stayed low throughout and the cause is unknown. Every timing comparison in this document was run back to back. No timing conclusion relies on numbers from different sessions, and the memory numbers are unaffected.

## Part 3: prelaunch and non-destructive optimizations on the Samsung (real profile)

Installed app (debuggable, real profile, all five extensions and blocking untouched). Configurations alternate trial by trial (5 rounds each), with fixture open after a 10 s settle. Prefs go through `/data/local/tmp/com.zmarn.once-geckoview-config.yaml`, removed afterwards. Medians; "content ready" is the content process's `RUNNING` relative to the `open` call.

| Dex state | Config | Shell UI | Content ready | Open → page loaded | Total PSS (fixture) |
|---|---|---:|---:|---:|---:|
| as installed (run-from-apk) | baseline | 2.17 s | +676 ms | 2.04 s | 844 MB |
| as installed | prelaunch on | 2.04 s | +726 ms | 2.45 s | 889 MB |
| `verify` | baseline | **1.78 s** | **+477 ms** | 1.96 s | **632 MB** |
| `verify` | prelaunch on | 1.91 s | +621 ms | 2.21 s | 708 MB |
| `verify` | no GPU process | 1.79 s | +314 ms | 1.90 s | 636 MB |
| `verify` | prelaunch + no GPU | 1.91 s | +365 ms | 2.14 s | 608 MB |

- **Compiling the dex (`verify`) is the clear win on the phone:** −212 MB total PSS (crashhelper 64 → 22, gpu 82 → 42, content 125 → 60 MB), shell UI −0.39 s, content process ready 200 ms sooner. Open → loaded improves only 0.08 s, because on the real profile the extension startup work dominates that path.
- **Prelaunch is a loss here:** slower (+0.25–0.4 s) and +60–76 MB for a spare content process. Once creates the Gecko runtime lazily on the first open, so the "prelaunched" process starts at the same moment it is needed and only competes with it. It would only help if the runtime were started before the user opens a page.
- **No GPU process:** content ready ≈160 ms sooner and open → loaded −60 ms. The memory saving (≈40 MB, the whole GPU process) is hidden by content-process noise in this run. A GPU or driver crash would then take down the main process, so it is a stability trade-off rather than a free win.
- The phone's app is left compiled `verify` (status `verify`, reason `cmdline`); a reinstall or deploy returns it to `run-from-apk`. The YAML, reverse tunnel and forwards are removed.

## Part 4: shipped fixes and first launch after a deploy

- **Uncompressed dex** (`packaging { dex { useLegacyPackaging = false } }` in `app/build.gradle`). Every install path now avoids the per-process dex copy, including `run android` (`cap run`), Android Studio and the E2E installers, which never ran the `verify` compile that `deploy` has done since `adcebba8`. On the emulator, a plain `adb install` left at `run-from-apk` showed no inflated-dex mapping in any process: crash helper 62 → 31 MB, GPU 82 → 55 MB. The APK grows ≈27 MB (258 MiB arm64 deploy). The Lite flavour builds with stored dex too.
- **Deploy to the Samsung** (`npm run deploy:mobile:android`): install 76 s, then the existing compile step left the app at `verify`. Child processes after the deploy: crash helper 22, GPU 39, content 79 MB, with no inflated-dex mapping anywhere.
- **First launch after a deploy is a memory spike, not a steady state:**
  - **First launch: main process 945 MB.** uBlock Origin held 131.6 MB (75.7 MB JS objects, 45.8 MB strings) while rebuilding its filter tables after the reinstall. The same process was back at 464 MB a few minutes later.
  - **Next cold start: main process 545 MB.** Gecko core held 251 MB, mostly 132 MB of small strings in the system zone, a 24 MB atoms table (normally ≈2 MB) and 6.9 MB of certificate storage. This fits Gecko importing its bundled RemoteSettings data after the update, but the cause is not confirmed.
  - **Steady state, hours after a deploy:** ≈390–420 MB.
  - This also explains the unreproduced 788 MB parent heap earlier: it was measured shortly after the 15:49 deploy.
