# Bundled Wafli runtime

The reader bundles the WebAssembly runtime built from
[`batram/wafli`](https://github.com/batram/wafli) commit
`05e1475c05f307bcddfb187d6a248585aa34978e`.

It contains Flite and the CMU US SLT voice under the license in `FLITE`, plus
Sonic time-scale modification under Apache-2.0 in `SONIC`. The generated
`wafli-module.js` and `wafli-module.wasm` are copied without modification from
that build.
