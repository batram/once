function devBuildIdentifier(environment = process.env, now = new Date()) {
  if (environment.ONCE_RELEASE_BUILD === "1") return ""
  if (environment.ONCE_BUILD_ID) return environment.ONCE_BUILD_ID

  return now.toISOString()
    .replace(/^(\d{2})(\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).*$/, "$2$3$4-$5$6$7")
}

module.exports = { devBuildIdentifier }
