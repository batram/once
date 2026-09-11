# Android reading media

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
