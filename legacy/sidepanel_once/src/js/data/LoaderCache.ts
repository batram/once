import { OnceSettings } from "../OnceSettings"

export class LoaderCache {
  static instance: LoaderCache
  static base_name = "loader_cache"

  constructor() {
    LoaderCache.instance = this
  }

  static initialize() {
    return new Promise((resolve, reject) => {
      let request = indexedDB.open(LoaderCache.base_name)
      request.onupgradeneeded = function () {
        request.result.createObjectStore("store")
        resolve(0)
      }
      request.onerror = function () {
        reject(request.error)
      }
    })
  }

  static async get_cached(url: string) {
    LoaderCache.initialize()
    const cache_time = await OnceSettings.instance.get_cache_time()

    return new Promise((resolve, reject) => {
      let oRequest = indexedDB.open(LoaderCache.base_name)
      oRequest.onsuccess = function () {
        let db = oRequest.result
        let tx = db.transaction("store", "readonly")
        let st = tx.objectStore("store")
        let gRequest = st.get(url)
        gRequest.onsuccess = function (e) {
          try {
            var cached = JSON.parse(gRequest.result)

            if (!Array.isArray(cached)) {
              reject("cached entry is not Array")
            }
            if (cached.length != 2) {
              reject("cached entry not length 2")
            }
            const mins_old = (Date.now() - cached[0]) / (60 * 1000)
            if (mins_old > cache_time) {
              reject("cached entry out of date " + mins_old)
            } else {
              console.log("cached", mins_old, url)
              resolve(cached[1])
            }
          } catch (e) {
            console.log("cache error", url, e)
            reject(null)
          }
          reject(null)
        }
        gRequest.onerror = function () {
          reject(gRequest.error)
        }
      }
      oRequest.onerror = function () {
        reject(oRequest.error)
      }
    })
  }

  static set_cached(key: string, content: string) {
    LoaderCache.initialize()

    return new Promise((resolve, reject) => {
      let oRequest = indexedDB.open(LoaderCache.base_name)
      oRequest.onsuccess = function () {
        let db = oRequest.result
        let tx = db.transaction("store", "readwrite")
        let st = tx.objectStore("store")
        let sRequest = st.put(content, key)
        sRequest.onsuccess = function () {
          resolve(0)
        }
        sRequest.onerror = function () {
          reject(sRequest.error)
        }
      }
      oRequest.onerror = function () {
        reject(oRequest.error)
      }
    })
  }
}
