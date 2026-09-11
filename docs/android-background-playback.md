# Android reading media

In the reading view, open the three-dot browser menu and enable **Keep media
playing in background**. The switch defaults to off and is saved on the device.
It applies to the GeckoView reading page across navigation and app launches.

When enabled, ongoing media can continue with another Once tab selected, with
Once in the background, or with the screen off. Playback shows an Android media
notification with a Pause action. It does not keep the screen illuminated.
Turning the switch off while the reading page is hidden pauses current media;
turning it off while reading leaves visible playback alone.

The foreground service and partial wake lock exist only while opted-in media is
playing. Pause, stop, page closure, content-process loss, and app destruction
release them. Audio-focus loss and headphone disconnection pause playback.
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

`BackgroundMediaTest` runs on a local Android emulator in the Once Dev package.
It drives the native switch and checks local PCM audio and generated VP8/Opus
video through three rounds each of hidden-tab, background-app, and screen-off
transitions, followed by disabled playback, notification Pause, and service
cleanup. It restores the preference and wakes
the emulator in its cleanup path. Run only on an explicitly selected local
emulator:

```text
adb -s emulator-5560 shell am instrument -w -r -e class com.zmarn.once.BackgroundMediaTest com.zmarn.once.dev.test/androidx.test.runner.AndroidJUnitRunner
```

The native API contracts are documented in Mozilla's
[GeckoSessionSettings](https://mozilla.github.io/geckoview/javadoc/mozilla-central/org/mozilla/geckoview/GeckoSessionSettings.html#setSuspendMediaWhenInactive(boolean))
and Android's [foreground services guide](https://developer.android.com/develop/background-work/services/fgs).
