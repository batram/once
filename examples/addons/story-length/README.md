# Story length add-on

From the Once checkout, run:

```powershell
npm run build:packages
node scripts/validate-addon.js examples/addons/story-length
```

For local Electron development, add this directory to `ONCE_ADDONS` and start
the unpackaged app. The local loader pins `main.js` automatically. Edit the
script or manifest to reload it.

For publication, replace `"script": "main.js"` with
`{ "url": "main.js", "integrity": "sha256-…" }`, using the digest printed by
the validator, then validate again. Host the directory over HTTPS and install
the manifest URL. The validator never executes the script.

The JSDoc annotation uses the public `OnceAddonApi` types from `@once/core`.
Keep the supplied story object when performing operations after `await`;
its identity ties the operation to the original invocation.

See [the author reference](../../../docs/ADDONS.md) for supported contributions,
options, capabilities, and platform limits.
