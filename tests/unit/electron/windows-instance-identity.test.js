const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

function loadIdentityModule() {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    "../../../apps/electron/src/WindowsInstanceIdentity.ts"
  ), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText
  const compiledModule = { exports: {} }
  Function("exports", "module", "require", compiled)(
    compiledModule.exports,
    compiledModule,
    require
  )
  return compiledModule.exports
}

const {
  installedAppUserModelId,
  windowsInstanceIdentity
} = loadIdentityModule()

const baseOptions = {
  buildChannel: "release",
  executablePath: "C:\\Tools\\Once A\\once.exe",
  isPackaged: true,
  platform: "win32",
  squirrelUpdateExists: false,
  userDataPath: "C:\\Users\\reader\\AppData\\Roaming\\Once"
}

test("portable copies in different directories receive separate profiles", () => {
  const first = windowsInstanceIdentity(baseOptions)
  const second = windowsInstanceIdentity({
    ...baseOptions,
    executablePath: "C:\\Tools\\Once B\\once.exe"
  })

  assert.notEqual(first.userDataPath, second.userDataPath)
  assert.notEqual(first.appUserModelId, second.appUserModelId)
})

test("a portable copy keeps its identity across executable changes", () => {
  const first = windowsInstanceIdentity(baseOptions)
  const renamed = windowsInstanceIdentity({
    ...baseOptions,
    executablePath: "c:\\tools\\once a\\renamed-once.exe"
  })

  assert.deepEqual(first, renamed)
  assert.match(first.userDataPath, /\\instances\\[a-f0-9]{16}$/)
})

test("installed, development, and non-Windows runs retain default profiles", () => {
  assert.equal(windowsInstanceIdentity({
    ...baseOptions,
    squirrelUpdateExists: true
  }), null)
  assert.equal(windowsInstanceIdentity({
    ...baseOptions,
    isPackaged: false
  }), null)
  assert.equal(windowsInstanceIdentity({
    ...baseOptions,
    platform: "linux"
  }), null)
})

test("installed release and dev channels use distinct Windows identities", () => {
  assert.equal(installedAppUserModelId("release"), "com.squirrel.once.once")
  assert.equal(
    installedAppUserModelId("dev"),
    "com.squirrel.oncedev.once-dev"
  )
})
