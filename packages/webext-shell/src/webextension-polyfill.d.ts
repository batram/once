declare module "webextension-polyfill" {
  const browserApi: typeof browser
  export = browserApi
}
