# Android reading media

## Fullscreen video and picture in picture

Use the website player's fullscreen button to watch above Once's browser and
tab controls. Android Back exits fullscreen and restores the reading viewport.
Fullscreen disables pull to refresh; rotating the device resizes the player.

Android reading pages also expose `video.requestPictureInPicture()`,
`document.exitPictureInPicture()`, `document.pictureInPictureEnabled` and
`document.pictureInPictureElement`. A player or userscript can request native PiP
directly from a click, without entering DOM fullscreen first. The request returns
a promise for a window with width, height and resize events; the video receives
enter/leave events. A ready video and user activation are required, and Android
permission failures reject the promise. The original video stays attached and
keeps its playback position. Returning to Once restores the inline page.

GeckoView 155 deliberately disables its unfinished Android web PiP API. Once
supplies a compatibility bridge to Android's native PiP rather than enabling that
preference. The bridge currently covers top-level reading documents. Videos in
cross-origin iframes still use the existing native fullscreen/Home path; this is
not a complete browser implementation of PiP CSS or every WebIDL interface.

While a fullscreen video is playing, go Home to enter Android picture in picture
(PiP). Expand the PiP window to return to the fullscreen player. Paused videos,
audio-only playback and fullscreen pages without video do not auto-enter PiP.
Android's per-app **Picture-in-picture** permission must be allowed, and the
device must support PiP. Android 12 and later use system auto-entry; Android
8–11 enter when the user leaves the activity.

PiP works independently of **Keep media playing in background**. While PiP is
visible, Once temporarily keeps that player active and supplies Android media
controls. Returning to the app restores the saved background-playback policy;
entering PiP never changes the preference. Closing or replacing the page releases
its fullscreen presentation.

Regular HTML video, fullscreen player containers (including YouTube), and
embedded players use Gecko's native fullscreen/media callbacks. The player must
successfully load and play its stream first. This does not change a website's
sign-in, subscription, DRM or playback restrictions.

The iOS reading surface explicitly permits WebKit PiP. Its page-media observer
tracks PiP in every frame and exempts active PiP from the normal
pause-on-background policy. WebKit owns page audio; Once activates its native
audio session only for reader speech. Activating both sessions caused repeated
system interruptions and paused YouTube playback on the connected iPhone.
WebKit and the site's player decide whether to expose PiP controls.

Switching to Stories keeps a PiP source attached behind the shell, without touch
handling, at its last usable size. Hiding or collapsing the WKWebView dismisses
WebKit's PiP window, so both are deferred until PiP exits. PiP tabs are also
excluded from memory-warning reclamation, including paused PiP. Explicit
presentation events take precedence over WebKit's sometimes stale
`document.pictureInPictureElement` getter after exiting PiP.
The page's legacy `webkitExitFullscreen` and `webkitExitFullScreen` methods
leave an active PiP presentation alone. YouTube calls this fullscreen cleanup
immediately after the native fullscreen player's PiP button succeeds; WebKit
otherwise interprets it as a PiP exit. Native PiP close and the explicit
`exitPictureInPicture` / `webkitSetPresentationMode("inline")` APIs still work.

## Background audio and video

In the reading view, open the three-dot browser menu and enable **Keep media
playing in background**. The switch defaults to off and is saved on the device.
It applies to the GeckoView reading page across navigation and app launches.

When enabled, ongoing media can continue with another Once tab selected, with
Once in the background, or with the screen off. Playback shows an Android media
notification and lock-screen controls. They show the title, artist/channel and
artwork when supplied by the page, plus duration and playback position when
available. Play/Pause, a seek bar, and ten-second jumps control the page's player.
Next/previous appear only when the site's media session supports them. Live or
otherwise unseekable media does not get a made-up duration or seek bar.
Playback does not keep the screen illuminated.
Turning the switch off while the reading page is hidden pauses current media;
turning it off while reading leaves visible playback alone.

The foreground service and partial wake lock exist only while opted-in media is
playing. Pausing releases foreground status, audio focus and the wake lock, but
retains the media card for resume for up to five minutes (or until Android or
Gecko disposes of the session). Stop, page closure, content-process loss, app
destruction, disabling the option, or dismissing the paused notification removes
the controls. Audio-focus loss and headphone disconnection pause playback.
Removing Once from recent apps stops its background playback.

This controls Once's playback policy. A website may independently pause its own
player when hidden, and replacing or closing the reading page ends that page's
media. The setting is Android-specific; Electron uses a different browser engine.

## Implementation and verification

`ReadingVideo` expands the attached Gecko surface above a black native backdrop,
restores the latest shell bounds on exit, handles Android Back, and
updates PiP eligibility and video aspect ratio. Android PiP transitions notify
Gecko's compositor so the PiP window presents the video rather than shrinking the
entire page. Background playback and PiP share the existing media service and
controls; PiP eligibility does not depend on the site's JavaScript PiP API.

The `BackgroundMediaTest#fullscreenVideoEntersPipWithoutBackgroundOptIn`
instrumentation test drives real page fullscreen controls, inspects DOM and
native geometry, and exercises Home, PiP Play/Pause, expansion, Back, paused-video
exclusion and tab hiding. It covers a fullscreen container and a video element
in portrait and landscape, against light and dark page backgrounds, with hardware
and gesture Back. It saves screenshots in the test app's
external files directory. `BackgroundMediaTest#youtubeFullscreenEntersPip` is an
opt-in live YouTube smoke (`-e youtubeLive true`) that requires a playable network
stream. Run the fullscreen fixture on an explicitly selected local emulator in
Once Dev, or in `com.zmarn.once.geckotest.dev` on a physical phone. The isolated
test application keeps the user's Once profiles separate. The live YouTube
instrumentation smoke remains emulator-only.

The fullscreen/PiP test passed on the Android 16 emulator, including DOM/native
geometry and playback controls with background playback disabled. The existing
video background-playback regression also passed in the final local run (one
cycle), including hidden-tab playback, backgrounding, screen-off resume, seeking
and cleanup. The live
YouTube PiP smoke remains unverified: the latest runs stopped before fullscreen
because the video stream stayed at `readyState = 0`. An earlier run loaded and
played the stream, but did not complete the fullscreen/PiP round trip.
Other Android devices and the Android 8–11 PiP entry path still need validation.

Physical Samsung Galaxy S20 FE (SM-G780G, Android 13) testing exposed a
second failure that clock-only assertions missed: audio kept advancing after
Android killed Gecko's cached GPU process, while video displayed a corrupt-file
error. Both a generated WebM and a fixed H.264/AAC clip reproduced it. PiP now
holds a balanced Gecko foreground reference while visible; opted-in background
media holds one while playing. Each releases its reference when its ownership
ends. This prevents GeckoRuntime's activity-pause notification from demoting the
GPU service while playback still needs its decoder surfaces. This uses
GeckoThread's reference-counted pause/resume integration and must be rechecked
when upgrading GeckoView.

The device regression uses a fixed H.264/AAC fixture and checks decoder errors
and visible video-frame progression as well as the media clock. It also covers
portrait/landscape, light/dark backgrounds, PiP Pause/Play, return, Back and
paused-video exclusion. A paused fullscreen -> Home -> resume -> PiP regression
explicitly clears media-session dimensions: `ReadingVideo` retains the current
presentation's last dimensions until fullscreen exits.

The mobile YouTube player also infers PiP from the outer-window/screen area
ratio, then calls `document.exitFullscreen()` and repeatedly pauses playback.
During native PiP only, the built-in media bridge reports the outer screen bounds
to YouTube's page world. The real inner viewport still resizes to the PiP window;
normal outer-window getters are restored on PiP exit or bridge disconnection.
Other sites are unchanged. The bridge version is bumped so existing profiles
receive this compatibility update.

The packaged build passed live mobile and desktop-site YouTube fullscreen ->
Home -> PiP -> return checks on that Samsung. Mobile YouTube was checked with
background playback disabled; desktop-site YouTube was checked with it enabled.
Both continued rendering frames with no decoder error. The strengthened native
fullscreen fixture passed its portrait, landscape, controls and paused/resume
cases on the same device. The separate background/screen-off regression verified
playback in the hidden tab, background app and screen-off states, but its full
round trip remains incomplete: the physical phone did not give the test activity
window focus after automatic wake/relaunch. Do not count that regression as
passing.

Android PiP currently uses Once's main activity. Reopening Once expands that
activity, returning to the inline player for direct JavaScript PiP and to
fullscreen for fullscreen/Home PiP. It does not keep a floating player above the
Stories view.

`StandardPipTest#standardVideoPipFromInline` exercises the JavaScript API with a
real H.264/AAC video on the isolated Samsung test app. It passed two light/dark
round trips, checking native PiP, a null DOM fullscreen element, correct video
geometry, ongoing decoded frames, Pause/Play, JavaScript exit, native return and
restoration of the inline player. The production build also passed live mobile
and desktop-site YouTube tests through Violentmonkey with the
`youtube-pip-button.user.js` 1.1 script. Both entered directly from its button and
kept decoding frames without a playback error. Desktop-site PiP was checked with
background playback disabled and entry from landscape. JavaScript exit and
reopening Once restored the inline player and cleared the button's active state.
The userscript retries feature detection after the native capability handshake;
the remaining userscripts and the background-playback preference are preserved.
Frame-by-frame inspection of the production entry recording still shows a brief
black frame while Gecko's SurfaceView changes size. Preparing the video before
native entry prevents the whole browser page being presented as the final PiP
content, but Android's cross-fade does not completely cover this renderer handoff.
Treat one-tap entry and continuous playback as verified; the animation still has
this visual limitation.

On the connected iPhone 16 Pro Max, YouTube PiP played continuously with
background playback disabled, survived switching between Reading and Stories,
and remained open while paused. Stories scrolled normally, with no horizontal
overflow, in light and dark themes. Exiting PiP while Stories was open hid the
source page normally. The native audio ownership, PiP event tracking and surface
lifecycle have regression tests. iPad and older iOS releases remain unverified.

`BackgroundMedia` owns the persisted preference and Gecko media delegate.
`BackgroundMediaService` supplies Android foreground playback, notification
controls, audio focus, and the screen-off wake lock. The surface continues to
report its actual active/inactive state. Disabling background playback explicitly
pauses already-hidden media because changing the Gecko setting alone does not
suspend an already-inactive playing session.

The inexpensive integration uses the existing Gecko MediaSession delegate and
Android's platform MediaSession; there is no new player library. Gecko metadata,
artwork, capabilities and position take priority. A small built-in content script
falls back to the active top-level HTML audio/video element's timeline and the
page title when native data is missing. YouTube additionally has title/channel
selectors, SPA navigation updates, and a guarded seek fallback. Page events drive
updates, with time updates limited to once per second; there is no polling timer.
Cross-origin embedded players rely on Gecko's native session data. Artwork is
loaded through Gecko and is optional. The bridge does not bypass a site's
autoplay, sign-in, subscription, DRM, or background-playback policy.

`BackgroundMediaTest` runs on a local Android emulator in the Once Dev package.
It drives the native switch and checks local PCM audio and generated VP8/Opus
video through three rounds each of hidden-tab, background-app, and screen-off
transitions, followed by disabled playback, Android metadata/position, seeking,
screen-off Play, notification Pause, and service cleanup. It restores the
preference and wakes the emulator in its cleanup path. Run only on an explicitly selected local
emulator:

```text
adb -s emulator-5560 shell am instrument -w -r -e class com.zmarn.once.BackgroundMediaTest com.zmarn.once.dev.test/androidx.test.runner.AndroidJUnitRunner
```

The separately opted-in `youtubeLiveControls` smoke uses a public YouTube video
and a test-only autoplay permission delegate to isolate media transport from
startup permission policy. It does not change the application's autoplay policy.
Run with `-e youtubeLive true -e class com.zmarn.once.BackgroundMediaTest#youtubeLiveControls`. The bridge unit tests
cover generic fallback, YouTube navigation, ad/live seek guards, stale commands,
and disabling observation.

Live verification observed YouTube's title, channel, artwork, duration, Android
Pause and seeking. The complete live smoke is not yet reliable: one run reached
those controls but failed its screen-off resume check, and another never loaded
media data. The local audio/video tests pass screen-off resume. Do not treat the
live smoke as proof that YouTube playback always survives backgrounding.

The native API contracts are documented in Mozilla's
[GeckoSessionSettings](https://mozilla.github.io/geckoview/javadoc/mozilla-central/org/mozilla/geckoview/GeckoSessionSettings.html#setSuspendMediaWhenInactive(boolean))
and Android's [foreground services guide](https://developer.android.com/develop/background-work/services/fgs).
