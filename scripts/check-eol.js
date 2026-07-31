// Every tracked text file must use LF in the working tree. .gitattributes
// enforces this on checkout; this check catches files that slipped in with
// CRLF from an editor or a tool that ignores .editorconfig.
const { execFileSync } = require("child_process")
const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const crlfAllowed = /\.(bat|cmd)$/i

const listing = execFileSync("git", ["ls-files", "--eol"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024
})

const offenders = []
for (const line of listing.split("\n")) {
  const match = /^i\/(\S+)\s+w\/(\S+)\s+attr\/(.*?)\t(.*)$/.exec(line)
  if (!match) continue
  const [, indexEol, workEol, , file] = match
  if (indexEol === "none" || workEol === "none") continue // binary
  if (crlfAllowed.test(file)) continue
  if (workEol === "crlf" || workEol === "mixed") {
    offenders.push({ file, workEol })
  }
}

if (offenders.length > 0 && process.argv.includes("--fix")) {
  for (const { file } of offenders) {
    const absolute = path.join(root, file)
    const buf = fs.readFileSync(absolute)
    const fixed = Buffer.from(
      buf.toString("binary").replace(/\r\n/g, "\n"),
      "binary"
    )
    fs.writeFileSync(absolute, fixed)
    console.log(`- converted ${file}`)
  }
  console.log(`Converted ${offenders.length} file(s) to LF.`)
  process.exit(0)
}

if (offenders.length > 0) {
  console.error("Line ending check failed (expected LF):")
  for (const { file, workEol } of offenders) {
    console.error(`- ${file} (${workEol})`)
  }
  console.error(
    "\nFix with: npm run check:eol -- --fix   (then commit the result)"
  )
  process.exit(1)
}

console.log("Line ending check passed: all tracked text files use LF.")
