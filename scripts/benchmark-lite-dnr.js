// Host-JVM benchmark, not an Android device measurement. Build Lite once to resolve RE2/J.
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const root = path.resolve(__dirname, "..")
const sourceRoot = process.argv[2] ? path.resolve(process.argv[2]) : root
const gradleHome = process.env.GRADLE_USER_HOME || path.join(os.homedir(), ".gradle")
const jars = [...fs.globSync(path.join(gradleHome, "caches/modules-2/files-2.1/com.google.re2j/re2j/1.8/*/*.jar"))]
if (jars.length !== 1) throw new Error("Build the Lite JVM tests first to resolve RE2/J 1.8")
const java = (name) => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-dnr-benchmark-"))
try {
  const sources = ["DnrEvaluator", "DnrUrlFilter", "MiniJson"].map((name) => path.join(sourceRoot,
    "apps/mobile/android/app/src/lite/java/com/zmarn/once/lite", `${name}.java`))
  execFileSync(java("javac"), ["-cp", jars[0], "-d", directory, ...sources,
    path.join(root, "tests/benchmarks/lite/DnrBenchmark.java")], { stdio: "inherit" })
  const output = execFileSync(java("java"), ["-cp", directory + path.delimiter + jars[0],
    "com.zmarn.once.lite.DnrBenchmark", path.join(root, "vendor/extensions/ublock-origin-lite/rulesets")], { encoding: "utf8" })
  const rows = output.trim().split("\n").map((line) => Object.fromEntries(line.trim().split(/\s+/).map((field) => {
    const [key, value] = field.split("=")
    return [key, Number(value)]
  })))
  console.log(JSON.stringify({ environment: "host JVM", platform: `${os.platform()} ${os.arch()}`,
    javaHome: process.env.JAVA_HOME ?? null, sourceRoot, ...rows[0], samples: rows.slice(1) }, null, 2))
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
