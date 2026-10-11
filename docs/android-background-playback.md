# Android reading media

## Fullscreen video and picture in picture

Use the website player's fullscreen button to watch above Once's browser and
tab controls. Android Back exits fullscreen and restores the reading viewport.
Fullscreen disables pull to refresh; rotating the device resizes the player.

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
stream. Run these only on an explicitly selected local emulator in Once Dev.

The fullscreen/PiP test passed on the Android 16 emulator, including DOM/native
geometry and playback controls with background playback disabled. The existing
video background-playback regression also passed in the final local run (one
cycle), including hidden-tab playback, backgrounding, screen-off resume, seeking
and cleanup. The live
YouTube PiP smoke remains unverified: the latest runs stopped before fullscreen
because the video stream stayed at `readyState = 0`. An earlier run loaded and
played the stream, but did not complete the fullscreen/PiP round trip. Physical
Android devices and the Android 8–11 PiP entry path still need validation.

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
