import Foundation

/// One place where an HTTP call to the gateway is built, signed with the
/// Keychain bearer token, and where a URLError is turned into the four error
/// codes the JS bridge contract promises.
///
/// Descends from ask-claude-watch/Sources/BridgeClient.swift, but that client
/// modelled one endpoint per method; here the page drives the paths, so this is
/// a generic transport instead.
enum GatewayClient {
    /// Network-level failure codes from the `rpc` contract.
    enum Failure: String {
        case cannotFindHost = "cannot_find_host"
        case timedOut = "timed_out"
        case refused
        /// TLS handshake failed: no cert configured on the peer, a
        /// self-signed/untrusted cert, or a clock/validity mismatch. Distinct
        /// from `.other` so the https-first probe (and the banner, if the
        /// stored scheme is https and it later breaks) can say something more
        /// useful than "the gateway isn't running".
        case tlsError = "tls_error"
        case other
    }

    enum Outcome {
        case http(status: Int, data: Data)
        case failure(Failure, message: String)
    }

    private static let rpcSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 20
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private static let probeSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        config.timeoutIntervalForResource = 4
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    static func request(
        path: String, method: String = "GET", body: Any? = nil,
        scheme overrideScheme: String? = nil, port overridePort: Int? = nil
    ) -> URLRequest? {
        let url = overrideScheme.flatMap { GatewayConfig.probeURL(path, scheme: $0, port: overridePort) }
            ?? GatewayConfig.url(path)
        guard let url else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = method.uppercased()
        let token = GatewayConfig.token
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body, !(body is NSNull) {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [])
        }
        return req
    }

    /// 15 s timeout: the `rpc` bridge method's budget.
    static func send(path: String, method: String = "GET", body: Any? = nil) async -> Outcome {
        await send(request: request(path: path, method: method, body: body), session: rpcSession)
    }

    /// 3 s timeout: the connectivity probe's budget, short enough that a
    /// sleeping Mac reads as "asleep" while the user is still looking at it.
    static func probe(path: String = "/health") async -> Outcome {
        await send(request: request(path: path), session: probeSession)
    }

    /// Explicit-https probe on the standard TLS port (443 unless
    /// `port` is given for testing) — see `GatewayConfig.probeURL`.
    static func probeHTTPS(path: String = "/health", port: Int? = nil) async -> Outcome {
        await send(request: request(path: path, scheme: "https", port: port), session: probeSession)
    }

    /// Explicit-http probe against the stored gateway port, regardless of
    /// which scheme Settings currently has selected. Used as the fallback leg
    /// of `probePreferredScheme` so it never accidentally re-probes https.
    static func probeHTTP(path: String = "/health") async -> Outcome {
        await send(request: request(path: path, scheme: "http"), session: probeSession)
    }

    struct SchemeProbeResult {
        /// Which scheme actually answered — what the caller should treat as
        /// "the" outcome and, for a Test-connection button, what Settings
        /// should switch to.
        let scheme: String
        let outcome: Outcome
        /// True only once the https leg's response is recognizably OUR
        /// gateway (see `isGatewayResponse`), never merely "got some HTTP
        /// response back". Port 443 on a tailnet host can belong to a
        /// captive portal, a corporate TLS-intercepting proxy, or an
        /// unrelated service; any of those can return a well-formed HTTP
        /// response (200 with an HTML login page, a redirect, a 404) that is
        /// NOT the gateway. Switching Settings to https/443 on that basis
        /// would point the app at the wrong endpoint until manually reverted.
        let httpsAvailable: Bool
    }

    /// True when `status`/`data` matches the exact shape this gateway's own
    /// `/health` route produces (see `scripts/gateway/src/server.ts`). The
    /// probe request carries the real bearer token (`request()` signs every
    /// call off the stored token regardless of the scheme override), so
    /// against the actual gateway this is a 200 with a `state` field that is
    /// one of the two values `getHealth` ever emits; a wrong/missing token
    /// still counts, since a genuine gateway with a stale token 401s with
    /// exactly `{"error":"unauthorized"}` — a shape a captive portal, TLS
    /// proxy, or unrelated https server on 443 won't happen to reproduce.
    private static func isGatewayResponse(status: Int, data: Data) -> Bool {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        switch status {
        case 401:
            return json["error"] as? String == "unauthorized"
        case 200:
            let state = json["state"] as? String
            return state == "ready" || state == "starting"
        default:
            return false
        }
    }

    /// https-first connectivity probe: tries HTTPS on the standard `tailscale
    /// serve --https=443` port before falling back to the stored HTTP
    /// gateway port. No cert configured, nothing listening on 443, a
    /// TLS/cert error, or a real HTTP response that isn't recognizably this
    /// gateway (`isGatewayResponse`) all fall through to HTTP silently.
    static func probePreferredScheme(path: String = "/health") async -> SchemeProbeResult {
        let httpsOutcome = await probeHTTPS(path: path)
        if case .http(let status, let data) = httpsOutcome, isGatewayResponse(status: status, data: data) {
            return SchemeProbeResult(scheme: "https", outcome: httpsOutcome, httpsAvailable: true)
        }
        let httpOutcome = await probeHTTP(path: path)
        return SchemeProbeResult(scheme: "http", outcome: httpOutcome, httpsAvailable: false)
    }

    private static func send(request: URLRequest?, session: URLSession) async -> Outcome {
        guard let request else {
            return .failure(.other, message: "Bad gateway URL. Check Settings.")
        }
        do {
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            return .http(status: status, data: data)
        } catch {
            let failure = classify(error)
            return .failure(failure, message: error.localizedDescription)
        }
    }

    static func classify(_ error: Error) -> Failure {
        guard let urlError = error as? URLError else { return .other }
        switch urlError.code {
        case .cannotFindHost, .dnsLookupFailed:
            // Tailscale's MagicDNS is gone, so the tailnet name does not resolve.
            return .cannotFindHost
        case .timedOut:
            // Route exists, nothing answers: the Mac is asleep.
            return .timedOut
        case .cannotConnectToHost:
            // TCP RST: the host is up but nothing is listening on the port.
            return .refused
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid,
             .clientCertificateRejected, .clientCertificateRequired:
            // TLS handshake itself failed: no cert on the peer at all (most
            // likely — Tailscale HTTPS certs aren't enabled for this
            // tailnet), a self-signed/untrusted cert, or a clock/validity
            // mismatch. Verified empirically against a local self-signed
            // server on this Mac: URLSession reports `.serverCertificateUntrusted`
            // ("The certificate for this server is invalid…") for a plain
            // self-signed cert with no custom trust anchor.
            return .tlsError
        default:
            return .other
        }
    }
}

/// Connectivity states from CONTRACTS.md, with the exact user-facing copy.
enum ConnectivityState: String {
    case ok
    case tailscaleOff = "tailscale_off"
    case macAsleep = "mac_asleep"
    case gatewayDown = "gateway_down"
    case unauthorized
    /// The stored scheme is https and the TLS handshake itself is failing —
    /// distinct from `.gatewayDown` so the banner doesn't say "isn't running"
    /// about a gateway that's actually fine over http.
    case tlsError = "tls_error"
    case starting

    var message: String {
        switch self {
        // Scheme in use, per CONTRACTS.md's ask for "a banner explaining the
        // scheme in use": read live off GatewayConfig rather than threaded
        // through the outcome, since it's the same for every `.ok` probe.
        case .ok: return "Connected via \(GatewayConfig.scheme.uppercased())."
        case .tailscaleOff: return "Tailscale isn't connected."
        case .macAsleep: return "Your Mac is asleep."
        case .gatewayDown: return "The vault gateway isn't running."
        case .unauthorized: return "Gateway rejected the token."
        case .tlsError: return "HTTPS certificate problem — switch to HTTP in Settings, or fix the cert."
        case .starting: return "Gateway is starting up."
        }
    }

    var isProblem: Bool { self != .ok }

    /// What the banner's action button does, if anything.
    enum Action { case none, openTailscale, openSettings }

    var action: Action {
        switch self {
        case .tailscaleOff: return .openTailscale
        case .unauthorized, .tlsError: return .openSettings
        default: return .none
        }
    }

    var actionTitle: String? {
        switch action {
        case .openTailscale: return "Open Tailscale"
        case .openSettings: return "Settings"
        case .none: return nil
        }
    }

    static func from(_ outcome: GatewayClient.Outcome) -> ConnectivityState {
        switch outcome {
        case .http(let status, _):
            switch status {
            case 200...299: return .ok
            case 401, 403: return .unauthorized
            case 503: return .starting
            default: return .gatewayDown
            }
        case .failure(let failure, _):
            switch failure {
            case .cannotFindHost: return .tailscaleOff
            case .timedOut: return .macAsleep
            case .refused: return .gatewayDown
            case .tlsError: return .tlsError
            case .other: return .gatewayDown
            }
        }
    }
}
