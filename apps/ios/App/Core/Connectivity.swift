import Foundation
import Network

/// Watches the network path (NWPathMonitor) and calls `onAvailable` on the main actor whenever a
/// usable path appears after none, or the path changes interface (Wi-Fi ↔ cellular). AppModel uses
/// it to retry at once instead of waiting for the next backoff step.
@MainActor
final class Connectivity {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "app.hermes.connectivity")
    private var lastSatisfied: Bool?
    private var lastInterfaces: [NWInterface.InterfaceType] = []
    private(set) var isSatisfied = true

    var onAvailable: (@MainActor () -> Void)?

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            let interfaces = [NWInterface.InterfaceType.wifi, .cellular, .wiredEthernet, .other].filter { path.usesInterfaceType($0) }
            Task { @MainActor in self?.update(satisfied: satisfied, interfaces: interfaces) }
        }
        monitor.start(queue: queue)
    }

    private func update(satisfied: Bool, interfaces: [NWInterface.InterfaceType]) {
        defer { lastSatisfied = satisfied; lastInterfaces = interfaces; isSatisfied = satisfied }
        guard satisfied, let previous = lastSatisfied else { return } // first report: nothing changed
        if !previous || interfaces != lastInterfaces { onAvailable?() }
    }

    deinit { monitor.cancel() }
}
