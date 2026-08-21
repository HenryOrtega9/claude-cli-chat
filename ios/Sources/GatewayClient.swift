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

    static func request(path: String, method: String = "GET", body: Any? = nil) -> URLRequest? {
        guard let url = GatewayConfig.url(path) else { return nil }
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
    case starting

    var message: String {
        switch self {
        case .ok: return "Connected."
        case .tailscaleOff: return "Tailscale isn't connected."
        case .macAsleep: return "Your Mac is asleep."
        case .gatewayDown: return "The vault gateway isn't running."
        case .unauthorized: return "Gateway rejected the token."
        case .starting: return "Gateway is starting up."
        }
    }

    var isProblem: Bool { self != .ok }

    /// What the banner's action button does, if anything.
    enum Action { case none, openTailscale, openSettings }

    var action: Action {
        switch self {
        case .tailscaleOff: return .openTailscale
        case .unauthorized: return .openSettings
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
            case .other: return .gatewayDown
            }
        }
    }
}
