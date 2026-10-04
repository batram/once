import Network

// Native WebKit tests: a loopback server distinguishes blocked requests from
// DNS/network failures. Never relies on a third-party ad endpoint being online.
extension ExtensionBenchmark {
    func filterRegression() async throws {
        let server = try NWListener(using: .tcp, on: .any)
        server.newConnectionHandler = { connection in
            connection.start(queue: .main)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { _, _, _, _ in
                let reply = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\nOK"
                connection.send(content: Data(reply.utf8), completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            server.stateUpdateHandler = { state in
                if case .ready = state { continuation.resume(returning: server.port!.rawValue); server.stateUpdateHandler = nil }
                if case .failed(let error) = state { continuation.resume(throwing: error); server.stateUpdateHandler = nil }
            }
            server.start(queue: .main)
        }
        defer { server.cancel() }
        let base = "http://127.0.0.1:\(port)"
        let compiler = IOSContentRuleCompiler()
        let encoded = try IOSContentBlockerExporter.export("||127.0.0.1^*blocked\n@@||127.0.0.1^*blocked-allowed\n##.advert")
        let list = try await compiler.compile(encoded)!
        let cached = try await compiler.compile(encoded)!
        result["cacheIdentifierStable"] = list.identifier == cached.identifier
        let config = WKWebViewConfiguration()
        config.userContentController.add(list)
        web = WKWebView(frame: window!.bounds, configuration: config)
        web.navigationDelegate = self
        window!.rootViewController!.view.addSubview(web)
        func load() async throws {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                navigation = continuation
                web.loadHTMLString("<html><body><p class='advert'>Advert</p></body></html>", baseURL: URL(string: base + "/article"))
            }
        }
        func fetch(_ path: String) async throws -> Bool {
            try await web.callAsyncJavaScript("try { return (await fetch(url, {cache:'no-store'})).ok } catch { return false }", arguments: ["url": base + path], in: nil, contentWorld: .page) as! Bool
        }
        try await load()
        result["blocked"] = !(try await fetch("/blocked"))
        result["exceptionAllowed"] = try await fetch("/blocked-allowed")
        result["ordinaryAllowed"] = try await fetch("/ordinary")
        result["cosmeticHidden"] = try await web.evaluateJavaScript("getComputedStyle(document.querySelector('.advert')).display === 'none'")
        do { _ = try await compiler.compile("invalid JSON"); result["invalidRejected"] = false }
        catch { result["invalidRejected"] = true }
        result["stillBlockedAfterFailure"] = !(try await fetch("/blocked"))
        let empty = try await compiler.compile("[]")
        result["emptyReturnsNil"] = empty == nil
        config.userContentController.remove(list)
        try await load()
        result["allowedAfterClearing"] = try await fetch("/blocked")
        result["cosmeticCleared"] = try await web.evaluateJavaScript("getComputedStyle(document.querySelector('.advert')).display !== 'none'")
        // End-of-URL and separator branches must both survive native compilation.
        var controls: [[String: Any]] = []
        for source in ["||ads.example^", "foo^bar", "foo^*^", "|https://ads.example/|", "ads.example^*"] {
            let json = try IOSContentBlockerExporter.export(source)
            _ = try await compiler.compile(json)
            controls.append(["source": source, "compiled": true])
        }
        result["controls"] = controls
        let preparation = IOSFilterPreparation()
        let first = preparation.prepare([]), same = preparation.prepare([])
        let firstJSON = try await first.value
        let sameJSON = try await same.value
        result["emptyPreparation"] = firstJSON == "[]" && sameJSON == "[]"
        result["thermalEnd"] = clock.thermalState.rawValue
    }
}
