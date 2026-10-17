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
 - While the iPhone navigates (Milestone 4, CarPlayGuidanceController): the
   route still to drive is drawn, and the camera follows the car, heading up.
   Zoom changes how close it follows; panning stops following, and recentre
   follows again. Otherwise the camera never follows the position by itself.
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
    /// Following the car while navigating
    static let guidanceZoom: CGFloat = 16
    static let guidancePitch: CGFloat = 40
  }

  /// The route line: the iPhone's route colours (lib/navigation/routeLayers.ts ROUTE_COLORS)
  enum RouteStyle {
    static let source = "derwent-carplay-route"
    static let casingLayer = "derwent-carplay-route-casing"
    static let lineLayer = "derwent-carplay-route-line"
    /// Mapbox's 2D location puck: the route goes under it
    static let puckLayer = "puck"
    static let color = UIColor(red: 0x4C / 255, green: 0x8D / 255, blue: 0xFF / 255, alpha: 1)
    static let casingColor = UIColor(red: 0x17 / 255, green: 0x3B / 255, blue: 0x7A / 255, alpha: 1)
    static let width: Double = 6
    static let casingWidth: Double = 10
  }

  private let settings: CarPlayMapSettings
  private var mapView: MapView?
  private var cancelables = Set<AnyCancelable>()
  /// Navigating on the iPhone; following the car (until panned away)
  private var guiding = false
  private var following = false
  private var followZoom = Camera.guidanceZoom
  /// The route still to drive, and whether the style can draw it yet
  private var routeLine: [CLLocationCoordinate2D]?
  private var routeDrawable = false

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

    Self.showPosition(on: mapView)

    cancelables.insert(mapView.mapboxMap.onStyleLoaded.observe { [weak self] _ in
      mapLog.notice("CarPlay map style loaded")
      self?.addRouteLayers()
    })
    cancelables.insert(mapView.mapboxMap.onMapLoadingError.observe { error in
      mapLog.error("CarPlay map loading error: \(String(describing: error), privacy: .public)")
    })

    view.addSubview(mapView)
    self.mapView = mapView
    mapLog.notice("CarPlay map created")
    if guiding { follow() }
  }

  // MARK: - Camera (driven by the map template)

  /// The current position, where location access was already granted (never asks)
  private static func showPosition(on mapView: MapView) {
    guard locationAuthorized() else { return }
    mapView.location.options.puckType = .puck2D(.makeDefault(showBearing: true))
    mapView.location.options.puckBearingEnabled = true
    mapView.location.options.puckBearing = .course
  }

  func zoom(by delta: CGFloat) {
    guard let mapView else { return }
    if following {
      // Closer to or further from the car, still following
      followZoom = Self.clampZoom(followZoom + delta)
      follow()
      return
    }
    let zoom = Self.clampZoom(mapView.mapboxMap.cameraState.zoom + delta)
    mapView.camera.ease(to: CameraOptions(zoom: zoom), duration: 0.3)
  }

  private static func clampZoom(_ zoom: CGFloat) -> CGFloat {
    min(max(zoom, Camera.zoomRange.lowerBound), Camera.zoomRange.upperBound)
  }

  /// The part of the map CarPlay's own controls don't cover
  private func visibleFrame(_ mapView: MapView) -> CGRect {
    mapView.bounds.inset(by: mapView.safeAreaInsets)
  }

  var visibleSize: CGSize {
    guard let mapView else { return .zero }
    return visibleFrame(mapView).size
  }

  /// Panning (a drag, or a step of the panning arrows): the map's content
  /// moves by `offset` screen points, at once. Following the car stops, and
  /// a zoom or recentre still animating is stopped first, so neither can
  /// move the camera back. The map stays where it's put until recentred.
  func move(by offset: CGPoint) {
    guard let mapView, offset != .zero else { return }
    stopFollowing()
    mapView.camera.cancelAnimations()
    let frame = visibleFrame(mapView)
    let from = CGPoint(x: frame.midX, y: frame.midY)
    let to = CGPoint(x: from.x + offset.x, y: from.y + offset.y)
    mapView.mapboxMap.setCamera(to: mapView.mapboxMap.dragCameraOptions(from: from, to: to))
  }

  /// Back to the car: following it while navigating, else to its position (when shown), else the overview
  func recenter() {
    guard let mapView else { return }
    if guiding {
      follow()
      return
    }
    if let coordinate = mapView.location.latestLocation?.coordinate {
      mapView.camera.ease(to: CameraOptions(center: coordinate, zoom: Camera.localZoom, bearing: 0), duration: 0.6)
    } else {
      mapView.camera.ease(to: CameraOptions(center: Camera.overviewCenter, zoom: Camera.overviewZoom, bearing: 0), duration: 0.6)
    }
  }

  // MARK: - Guidance (driven by CarPlayGuidanceController)

  /// Navigation started on the iPhone: follow the car
  func beginGuidance() {
    guiding = true
    followZoom = Camera.guidanceZoom
    // (Before the map exists, viewDidLoad starts following)
    guard let mapView else { return }
    if mapView.location.options.puckType == nil { Self.showPosition(on: mapView) }
    follow()
  }

  /// Navigation ended: stop following; the camera stays where it is
  func endGuidance() {
    guiding = false
    stopFollowing()
  }

  private func follow() {
    guard let mapView, guiding else { return }
    var options = FollowPuckViewportStateOptions()
    // The car in the middle of what CarPlay's guidance cards leave visible
    options.padding = mapView.safeAreaInsets
    options.zoom = followZoom
    options.bearing = .course
    options.pitch = Camera.guidancePitch
    mapView.viewport.transition(to: mapView.viewport.makeFollowPuckViewportState(options: options))
    following = true
  }

  private func stopFollowing() {
    guard following, let mapView else { return }
    following = false
    mapView.viewport.idle()
  }

  /// The route still to drive (nil: none)
  func setRouteLine(_ coordinates: [CLLocationCoordinate2D]?) {
    routeLine = coordinates
    drawRoute()
  }

  /// With each style load: the route's source and its casing and line, under the position puck
  private func addRouteLayers() {
    guard let mapView else { return }
    let style = mapView.mapboxMap.style
    do {
      if !style.sourceExists(withId: RouteStyle.source) {
        var source = GeoJSONSource(id: RouteStyle.source)
        source.data = .geometry(.lineString(LineString(routeLine ?? [])))
        try style.addSource(source)
      }
      let position: LayerPosition? = style.layerExists(withId: RouteStyle.puckLayer) ? .below(RouteStyle.puckLayer) : nil
      if !style.layerExists(withId: RouteStyle.casingLayer) {
        var casing = LineLayer(id: RouteStyle.casingLayer, source: RouteStyle.source)
        casing.lineColor = .constant(StyleColor(RouteStyle.casingColor))
        casing.lineWidth = .constant(RouteStyle.casingWidth)
        casing.lineCap = .constant(.round)
        casing.lineJoin = .constant(.round)
        try style.addLayer(casing, layerPosition: position)
      }
      if !style.layerExists(withId: RouteStyle.lineLayer) {
        var line = LineLayer(id: RouteStyle.lineLayer, source: RouteStyle.source)
        line.lineColor = .constant(StyleColor(RouteStyle.color))
        line.lineWidth = .constant(RouteStyle.width)
        line.lineCap = .constant(.round)
        line.lineJoin = .constant(.round)
        try style.addLayer(line, layerPosition: position)
      }
      routeDrawable = true
      drawRoute()
    } catch {
      mapLog.error("CarPlay route layers not added: \(String(describing: error), privacy: .public)")
    }
  }

  private func drawRoute() {
    guard routeDrawable, let mapView else { return }
    do {
      try mapView.mapboxMap.style.updateGeoJSONSource(withId: RouteStyle.source, geoJSON: .geometry(.lineString(LineString(routeLine ?? []))))
    } catch {
      mapLog.error("CarPlay route not drawn: \(String(describing: error), privacy: .public)")
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
