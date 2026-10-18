const minOff = 60
const hourOff = 60 * minOff
const dayOff = 24 * hourOff
const monthOff = 30 * dayOff
const yearOff = 365 * dayOff

export function daysAgo(timestamp: number, now = Date.now()): number {
  return (now - timestamp) / dayOff / 1000
}

export function humanTime(time: string | Date | number, now = Date.now()): string {
  const timestamp = parseInt(time ? time.toString() : "")
  const offset = (now - timestamp) / 1000
  let res = "?"

  if (offset < minOff) {
    res = "seconds ago"
  } else if (offset < hourOff) {
    const mins = Math.round(offset / minOff)
    if (mins <= 1) {
      res = "1 min ago"
    } else {
      res = mins + " mins ago"
    }
  } else if (offset < dayOff) {
    const hour = Math.round(offset / hourOff)
    if (hour <= 1) {
      res = "1 hour ago"
    } else {
      res = hour + " hours ago"
    }
  } else if (offset < monthOff) {
    const day = Math.round(offset / dayOff)
    if (day <= 1) {
      res = "1 day ago"
    } else {
      res = day + " days ago"
    }
  } else if (offset < yearOff) {
    const month = Math.round(offset / monthOff)
    if (month <= 1) {
      res = "1 month ago"
    } else {
      res = month + " months ago"
    }
  } else {
    if (offset / yearOff <= 1) {
      res = "1 year ago"
    } else {
      res = Math.round(offset / yearOff) + " years ago"
    }
  }

  return res
}
