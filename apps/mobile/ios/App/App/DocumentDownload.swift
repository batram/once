import Foundation
import Capacitor

// Downloads a document for Reader with a byte cap enforced as data arrives,
// so a server that misreports or omits Content-Length cannot fill memory
// before the shell's own limit applies. Only the trusted shell bridge can
// call this; it follows redirects and sends cookies only when asked to.
extension InAppBrowserSurfacePlugin {
    @objc func fetchDocument(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            call.reject("Invalid document URL")
            return
        }
        let limit = min(max(call.getInt("maxBytes") ?? 0, 1), 256 * 1024 * 1024)
        let includeCredentials = call.getString("credentials") == "include"
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = includeCredentials
        request.timeoutInterval = 60
        if let headers = call.getObject("headers") {
            for (name, value) in headers {
                guard let text = value as? String, name.lowercased() != "cookie" || includeCredentials else { continue }
                request.setValue(text, forHTTPHeaderField: name)
            }
        }
        BoundedDownload(limit: limit, storesCookies: includeCredentials).start(request) { result in
            switch result {
            case .success(let download):
                var headers: [String: String] = [:]
                for (name, value) in download.response.allHeaderFields {
                    if let name = name as? String, let value = value as? String { headers[name] = value }
                }
                call.resolve([
                    "status": download.response.statusCode,
                    "url": download.response.url?.absoluteString ?? urlString,
                    "headers": headers,
                    "base64": download.data.base64EncodedString()
                ])
            case .failure(let error):
                call.reject(error.message)
            }
        }
    }
}

struct DownloadFailure: Error { let message: String }

final class BoundedDownload: NSObject, URLSessionDataDelegate {
    private let limit: Int
    private let storesCookies: Bool
    private var data = Data()
    private var session: URLSession?
    private var completion: ((Result<(response: HTTPURLResponse, data: Data), DownloadFailure>) -> Void)?

    init(limit: Int, storesCookies: Bool) {
        self.limit = limit
        self.storesCookies = storesCookies
    }

    func start(_ request: URLRequest, completion: @escaping (Result<(response: HTTPURLResponse, data: Data), DownloadFailure>) -> Void) {
        self.completion = completion
        let configuration = URLSessionConfiguration.default
        configuration.httpShouldSetCookies = storesCookies
        configuration.httpCookieAcceptPolicy = storesCookies ? .onlyFromMainDocumentDomain : .never
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session
        session.dataTask(with: request).resume()
    }

    private func finish(_ result: Result<(response: HTTPURLResponse, data: Data), DownloadFailure>) {
        guard let completion = completion else { return }
        self.completion = nil
        session?.invalidateAndCancel()
        session = nil
        completion(result)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if response.expectedContentLength > Int64(limit) {
            completionHandler(.cancel)
            finish(.failure(DownloadFailure(message: "Document too large")))
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        data.append(chunk)
        if data.count > limit {
            dataTask.cancel()
            finish(.failure(DownloadFailure(message: "Document too large")))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            finish(.failure(DownloadFailure(message: error.localizedDescription)))
            return
        }
        guard let response = task.response as? HTTPURLResponse else {
            finish(.failure(DownloadFailure(message: "Document download failed")))
            return
        }
        finish(.success((response: response, data: data)))
    }
}
