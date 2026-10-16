import CoreLocation
import MapboxMaps
import UIKit
import os

private let mapLog = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Derwent", category: "CarPlay")

/**
 The CarPlay window's map (Milestone 3): the Derwent Mapbox style, drawn
 natively with the Mapbox Maps SDK the app already has.

 - Map content only, as Apple requires for a navigation app's window:
   CarPlay's own map template draws every control above it, and the window
   receives no touches. Mapbox's logo and attribution stay visible.
 - The camera starts on the phone's last known position when the app already
   has location access, else on Great Britain. Zoom, panning and recentring
   come from the map template's buttons and gestures (CarPlayMapTemplateController).
 - The current position is shown only if location access was already granted
   (this never asks for it). Display only: it doesn't feed navigation, drive
   recording or location sharing.
 */
final class CarPlayMapViewController: UIViewController {
  enum Camera {
    /// Great Britain, when there's no position to start from
    static let overviewCenter = CLLocationCoordinate2D(latitude: 54.4, longitude: -2.9)
    static let overviewZoom: CGFloat = 4.6
    /// Around the car
    static let localZoom: CGFloat = 14
    static let zoomRange: ClosedRange<CGFloat> = 3...20
    /// A last known position older than this isn't a starting point (s)
    static let maxLastKnownAge: TimeInterval = 24 * 60 * 60
  }

  private let settings: CarPlayMapSettings
  private var mapView: MapView?
  private var cancelables = Set<AnyCancelable>()

  init(settings: CarPlayMapSettings) {
    self.settings = settings
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not used")
  }

  override func loadView() {
    let view = UIView()
    // Derwent's dark background while the style loads
    view.backgroundColor = UIColor(red: 0x0A / 255, green: 0x0D / 255, blue: 0x10 / 255, alpha: 1)
    self.view = view
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    // The same public token the iPhone's map sets from JavaScript
    MapboxOptions.accessToken = settings.accessToken
    let options = MapInitOptions(
      cameraOptions: Self.initialCamera(),
      styleURI: StyleURI(rawValue: settings.styleURL) ?? .dark
    )
    let mapView = MapView(frame: view.bounds, mapInitOptions: options)
    mapView.autoresizingMask = [.flexibleWidth, .flexibleHeight]

    // Mapbox's logo and attribution stay visible (Mapbox's terms). CarPlay's
    // map buttons sit at the bottom trailing corner, so the attribution
    // moves beside the logo, bottom leading. No scale bar.
    mapView.ornaments.options.attributionButton.position = .bottomLeading
    mapView.ornaments.options.attributionButton.margins = CGPoint(x: 100, y: 8)
    mapView.ornaments.options.scaleBar.visibility = .hidden

    if Self.locationAuthorized() {
      mapView.location.options.puckType = .puck2D(.makeDefault(showBearing: true))
      mapView.location.options.puckBearingEnabled = true
      mapView.location.options.puckBearing = .course
    }

    cancelables.insert(mapView.mapboxMap.onStyleLoaded.observe { _ in
      mapLog.notice("CarPlay map style loaded")
    })
    cancelables.insert(mapView.mapboxMap.onMapLoadingError.observe { error in
      mapLog.error("CarPlay map loading error: \(String(describing: error), privacy: .public)")
    })

    view.addSubview(mapView)
    self.mapView = mapView
    mapLog.notice("CarPlay map created")
  }

  // MARK: - Camera (driven by the map template)

  func zoom(by delta: CGFloat) {
    guard let mapView else { return }
    let zoom = min(max(mapView.mapboxMap.cameraState.zoom + delta, Camera.zoomRange.lowerBound), Camera.zoomRange.upperBound)
    mapView.camera.ease(to: CameraOptions(zoom: zoom), duration: 0.3)
  }

  /// Arrow buttons and knob nudges while panning: a third of the screen per step
  func pan(_ dx: CGFloat, _ dy: CGFloat) {
    guard let mapView else { return }
    let step = CGPoint(x: dx * mapView.bounds.width / 3, y: dy * mapView.bounds.height / 3)
    let center = mapView.mapboxMap.coordinate(for: CGPoint(x: mapView.bounds.midX + step.x, y: mapView.bounds.midY + step.y))
    mapView.camera.ease(to: CameraOptions(center: center), duration: 0.3)
  }

  /// A drag on the CarPlay screen: the map follows the finger
  func drag(by delta: CGPoint) {
    guard let mapView, delta != .zero else { return }
    let center = mapView.mapboxMap.coordinate(for: CGPoint(x: mapView.bounds.midX - delta.x, y: mapView.bounds.midY - delta.y))
    mapView.mapboxMap.setCamera(to: CameraOptions(center: center))
  }

  /// Back to the car's position (when shown), else the overview
  func recenter() {
    guard let mapView else { return }
    if let coordinate = mapView.location.latestLocation?.coordinate {
      mapView.camera.ease(to: CameraOptions(center: coordinate, zoom: Camera.localZoom, bearing: 0), duration: 0.6)
    } else {
      mapView.camera.ease(to: CameraOptions(center: Camera.overviewCenter, zoom: Camera.overviewZoom, bearing: 0), duration: 0.6)
    }
  }

  // MARK: - Starting point

  private static func locationAuthorized() -> Bool {
    switch CLLocationManager().authorizationStatus {
    case .authorizedAlways, .authorizedWhenInUse: return true
    default: return false
    }
  }

  /// The phone's last known position (no location request), else Great Britain
  private static func initialCamera() -> CameraOptions {
    if locationAuthorized(),
       let last = CLLocationManager().location,
       -last.timestamp.timeIntervalSinceNow < Camera.maxLastKnownAge {
      return CameraOptions(center: last.coordinate, zoom: Camera.localZoom)
    }
    return CameraOptions(center: Camera.overviewCenter, zoom: Camera.overviewZoom)
  }
}
