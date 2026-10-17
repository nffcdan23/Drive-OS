import CoreLocation
import Foundation
import os

private let storeLog = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Derwent", category: "CarPlay")

/// A distance as the iPhone shows it (lib/navigation/carPlay.ts carPlayDistance)
struct CarPlayDistance: Equatable {
  let value: Double
  /// "mi", "yd", "km" or "m"
  let unit: String

  init?(_ any: Any?) {
    guard let d = any as? [String: Any], let value = number(d["value"]), value.isFinite, value >= 0,
          let unit = d["unit"] as? String, ["mi", "yd", "km", "m"].contains(unit) else { return nil }
    self.value = value
    self.unit = unit
  }

  var measurement: Measurement<UnitLength> {
    switch unit {
    case "mi": return Measurement(value: value, unit: .miles)
    case "yd": return Measurement(value: value, unit: .yards)
    case "km": return Measurement(value: value, unit: .kilometers)
    default: return Measurement(value: value, unit: .meters)
    }
  }
}

/// What CarPlay shows of the iPhone's navigation session: lib/navigation/carPlay.ts CarPlayGuidance, as sent
struct CarPlayGuidance: Equatable {
  struct Maneuver: Equatable {
    let id: String
    let instructions: [String]
    let symbol: String
    let distance: CarPlayDistance
  }

  struct Pause: Equatable {
    /// "loading", "locating" or "rerouting"
    let reason: String
    let text: String
  }

  let sessionId: Int
  /// "starting", "navigating", "offRoute", "rerouting" or "arrived"
  let phase: String
  let destinationName: String
  let destinationLatitude: Double
  let destinationLongitude: Double
  let via: String?
  let routeId: String?
  let pause: Pause?
  let maneuvers: [Maneuver]
  let remainingDistance: CarPlayDistance?
  let remainingTime: TimeInterval?

  var arrived: Bool { phase == "arrived" }

  var destination: CLLocationCoordinate2D {
    CLLocationCoordinate2D(latitude: destinationLatitude, longitude: destinationLongitude)
  }

  /// Nil for anything that isn't a complete, valid copy (it's then ignored)
  init?(_ d: [String: Any]) {
    guard let sessionId = number(d["sessionId"]), sessionId.isFinite,
          let phase = d["phase"] as? String,
          ["starting", "navigating", "offRoute", "rerouting", "arrived"].contains(phase),
          let destination = d["destination"] as? [String: Any],
          let name = destination["name"] as? String,
          let latitude = number(destination["latitude"]), let longitude = number(destination["longitude"]),
          CLLocationCoordinate2DIsValid(CLLocationCoordinate2D(latitude: latitude, longitude: longitude)),
          let maneuvers = d["maneuvers"] as? [Any] else { return nil }
    self.sessionId = Int(sessionId)
    self.phase = phase
    destinationName = name
    destinationLatitude = latitude
    destinationLongitude = longitude
    via = d["via"] as? String
    routeId = d["routeId"] as? String
    if let p = d["pause"] as? [String: Any] {
      guard let reason = p["reason"] as? String, ["loading", "locating", "rerouting"].contains(reason),
            let text = p["text"] as? String else { return nil }
      pause = Pause(reason: reason, text: text)
    } else {
      pause = nil
    }
    var parsed: [Maneuver] = []
    for any in maneuvers {
      guard let m = any as? [String: Any], let id = m["id"] as? String,
            let instructions = m["instructions"] as? [String], !instructions.isEmpty,
            let symbol = m["symbol"] as? String, let distance = CarPlayDistance(m["distance"]) else { return nil }
      parsed.append(Maneuver(id: id, instructions: instructions, symbol: symbol, distance: distance))
    }
    self.maneuvers = parsed
    if let r = d["remaining"] as? [String: Any] {
      guard let distance = CarPlayDistance(r["distance"]), let time = number(r["timeS"]), time.isFinite, time >= 0 else { return nil }
      remainingDistance = distance
      remainingTime = time
    } else {
      remainingDistance = nil
      remainingTime = nil
    }
  }
}

private func number(_ any: Any?) -> Double? {
  if let d = any as? Double { return d }
  if let i = any as? Int { return Double(i) }
  if let n = any as? NSNumber { return n.doubleValue }
  return nil
}

/**
 The latest copy of the iPhone's navigation session for the CarPlay screen
 (CarPlay Milestone 4). The navigation itself runs on the iPhone
 (lib/navigation/session.ts); its copy arrives here one way, on every
 change, through the CarPlay feed module (modules/derwent-carplay-feed).

 It's kept whether or not CarPlay is connected, so a CarPlay screen that
 connects (or reconnects) during a journey shows it straight away. Memory
 only: nothing is stored. Main thread only.
 */
public final class CarPlayNavigationStore {
  public static let shared = CarPlayNavigationStore()

  enum Change {
    case guidance
    case routeLine
  }

  /// Nil without navigation
  private(set) var guidance: CarPlayGuidance?
  /// The line still to drive; nil without one
  private(set) var routeLine: [CLLocationCoordinate2D]?
  private var observers: [Int: (Change) -> Void] = [:]
  private var nextToken = 0

  private init() {}

  /// The session's copy (lib/navigation/carPlay.ts CarPlayGuidance), or nil when navigation ends
  public func setGuidance(_ dictionary: [String: Any]?) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { self.setGuidance(dictionary) }
      return
    }
    let next = dictionary.flatMap(CarPlayGuidance.init)
    if dictionary != nil && next == nil {
      storeLog.error("CarPlay guidance ignored: incomplete")
      return
    }
    guard next != guidance else { return }
    if next?.sessionId != guidance?.sessionId {
      storeLog.notice("CarPlay guidance: \(next == nil ? "ended" : "session \(next!.sessionId)", privacy: .public)")
    }
    guidance = next
    notify(.guidance)
  }

  /// The line still to drive as [lng, lat, lng, lat, …], or nil
  public func setRouteLine(routeId: String?, coordinates: [Double]?) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { self.setRouteLine(routeId: routeId, coordinates: coordinates) }
      return
    }
    var line: [CLLocationCoordinate2D]?
    if routeId != nil, let c = coordinates, c.count >= 4, c.count % 2 == 0 {
      line = stride(from: 0, to: c.count, by: 2)
        .map { CLLocationCoordinate2D(latitude: c[$0 + 1], longitude: c[$0]) }
        .filter(CLLocationCoordinate2DIsValid)
      if line!.count < 2 { line = nil }
    }
    if line == nil && routeLine == nil { return }
    routeLine = line
    notify(.routeLine)
  }

  func observe(_ fn: @escaping (Change) -> Void) -> Int {
    nextToken += 1
    observers[nextToken] = fn
    return nextToken
  }

  func removeObserver(_ token: Int) {
    observers[token] = nil
  }

  private func notify(_ change: Change) {
    for fn in observers.values { fn(change) }
  }
}
