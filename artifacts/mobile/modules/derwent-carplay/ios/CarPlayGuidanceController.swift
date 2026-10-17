import CarPlay
import MapKit
import UIKit
import os

private let guidanceLog = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Derwent", category: "CarPlay")

/**
 Turn-by-turn guidance on the CarPlay screen (CarPlay Milestone 4), for the
 navigation session running on the iPhone (CarPlayNavigationStore). CarPlay
 doesn't navigate by itself: this only shows that session with Apple's
 navigation templates.

 - Navigation starts on the iPhone: a CPTrip to its destination and a
   CPNavigationSession on the map template (the destination's name, and the
   route's main roads). The map draws the route and follows the car.
 - While guiding: the next manoeuvre (and the one straight after, when the
   iPhone has one) with Mapbox's instruction, its arrow and distance; the
   distance and time left (CarPlay shows the arrival time from it).
 - Starting, off the route or rerouting: the trip is paused with the iPhone's
   words ("Starting navigation…", "You're off route", "Updating route…"),
   and no manoeuvre is shown.
 - Arriving: the trip is finished. Ending on the iPhone: it's cancelled.
 - CarPlay connecting during a journey shows it straight away; disconnecting
   only drops CarPlay's side (the iPhone's navigation carries on).

 One CPNavigationSession at most, for the iPhone's current session.
 */
final class CarPlayGuidanceController {
  private weak var template: CPMapTemplate?
  private weak var map: CarPlayMapViewController?
  private let store: CarPlayNavigationStore
  private var token: Int?
  /// The iPhone session shown, and its CarPlay side
  private var sessionId: Int?
  private var session: CPNavigationSession?
  private var trip: CPTrip?
  private var finished = false
  /// What the maneuver panel shows (to update estimates only, when it's the same)
  private var shown: [CarPlayGuidance.Maneuver] = []
  private var shownManeuvers: [CPManeuver] = []
  private var shownPause: CarPlayGuidance.Pause?

  init(template: CPMapTemplate, map: CarPlayMapViewController?, store: CarPlayNavigationStore = .shared) {
    self.template = template
    self.map = map
    self.store = store
  }

  /// CarPlay connected: show the journey under way, if any, and follow it
  func attach() {
    guard token == nil else { return }
    token = store.observe { [weak self] change in
      guard let self else { return }
      switch change {
      case .guidance: self.apply(self.store.guidance)
      case .routeLine: self.map?.setRouteLine(self.store.routeLine)
      }
    }
    map?.setRouteLine(store.routeLine)
    apply(store.guidance)
  }

  /// CarPlay disconnected: its side goes with it; the iPhone's navigation isn't touched
  func detach() {
    if let token { store.removeObserver(token) }
    token = nil
    session = nil
    trip = nil
    sessionId = nil
  }

  private func apply(_ guidance: CarPlayGuidance?) {
    guard let template else { return }
    guard let g = guidance else {
      // Navigation ended on the iPhone
      end()
      return
    }
    if g.sessionId != sessionId {
      // A new journey replaces any earlier one
      end()
      sessionId = g.sessionId
      if g.arrived {
        // Connected after arriving: nothing to guide
        finished = true
        return
      }
      begin(g, on: template)
    }
    guard let session, let trip, !finished else { return }
    if g.arrived {
      guidanceLog.notice("CarPlay trip finished: arrived")
      session.finishTrip()
      finished = true
      shown = []
      shownManeuvers = []
      shownPause = nil
      return
    }
    if let distance = g.remainingDistance, let time = g.remainingTime {
      template.updateEstimates(CPTravelEstimates(distanceRemaining: distance.measurement, timeRemaining: time), for: trip)
    }
    if let pause = g.pause {
      if pause != shownPause {
        session.pauseTrip(for: Self.reason(pause.reason), description: pause.text)
        shownPause = pause
        shown = []
        shownManeuvers = []
      }
      return
    }
    shownPause = nil
    if g.maneuvers.map(Self.identity) == shown.map(Self.identity), shownManeuvers.count == g.maneuvers.count {
      // The same manoeuvres: only how far away they are
      for (cp, m) in zip(shownManeuvers, g.maneuvers) {
        session.updateEstimates(Self.estimates(m.distance), for: cp)
      }
      return
    }
    // New manoeuvres (also resumes a paused trip)
    shownManeuvers = g.maneuvers.map(Self.maneuver)
    shown = g.maneuvers
    session.upcomingManeuvers = shownManeuvers
  }

  private func begin(_ g: CarPlayGuidance, on template: CPMapTemplate) {
    let destination = MKMapItem(placemark: MKPlacemark(coordinate: g.destination))
    destination.name = g.destinationName
    let choice = CPRouteChoice(summaryVariants: [g.via ?? g.destinationName], additionalInformationVariants: [], selectionSummaryVariants: [])
    let trip = CPTrip(origin: MKMapItem.forCurrentLocation(), destination: destination, routeChoices: [choice])
    // The guidance cards in Derwent's dark, over its dark map
    template.guidanceBackgroundColor = UIColor(red: 0x0A / 255, green: 0x0D / 255, blue: 0x10 / 255, alpha: 1)
    template.tripEstimateStyle = .dark
    session = template.startNavigationSession(for: trip)
    self.trip = trip
    finished = false
    shown = []
    shownManeuvers = []
    shownPause = nil
    map?.beginGuidance()
    guidanceLog.notice("CarPlay navigation started: session \(g.sessionId, privacy: .public)")
  }

  /// Ends CarPlay's side of the journey shown, if any
  private func end() {
    if let session, !finished {
      guidanceLog.notice("CarPlay trip cancelled: navigation ended on the iPhone")
      session.cancelTrip()
    }
    if sessionId != nil { map?.endGuidance() }
    session = nil
    trip = nil
    sessionId = nil
    finished = false
    shown = []
    shownManeuvers = []
    shownPause = nil
  }

  private static func identity(_ m: CarPlayGuidance.Maneuver) -> [String] {
    [m.id, m.symbol] + m.instructions
  }

  /// The manoeuvre panel's distance (the iPhone engine gives no time to a manoeuvre: none is shown)
  private static func estimates(_ distance: CarPlayDistance) -> CPTravelEstimates {
    CPTravelEstimates(distanceRemaining: distance.measurement, timeRemaining: 0)
  }

  private static func maneuver(_ m: CarPlayGuidance.Maneuver) -> CPManeuver {
    let maneuver = CPManeuver()
    maneuver.instructionVariants = m.instructions
    maneuver.initialTravelEstimates = estimates(m.distance)
    if let image = UIImage(systemName: m.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 40, weight: .semibold)) {
      // White on the dark guidance card
      maneuver.symbolImage = image.withTintColor(.white, renderingMode: .alwaysOriginal)
    }
    return maneuver
  }

  private static func reason(_ reason: String) -> CPTripPauseReason {
    switch reason {
    case "loading": return .loading
    case "locating": return .locating
    default: return .rerouting
    }
  }
}
