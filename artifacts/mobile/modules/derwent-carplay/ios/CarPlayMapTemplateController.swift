import CarPlay
import UIKit
import os

private let templateLog = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Derwent", category: "CarPlay")

/**
 The root CPMapTemplate and its controls (Milestone 3): only what makes sense
 before navigation is connected.

 - Map buttons: pan, zoom in, zoom out. CarPlay shows at most three ("When
   the array contains more than three buttons, the map template displays only
   the first three"), so the pan button comes first and recentre is in the
   navigation bar.
 - Navigation bar: "Derwent" (the map template has no title; a bar button is
   the supported place for the name) and recentre; "Done" too while panning
   (Apple: the system hides the map buttons while panning, and the app must
   provide the button that ends it).
 - Panning: the arrow buttons / knob in panning mode (every vehicle), and
   drags on the screen (only vehicles whose CarPlay reports them).

 While the iPhone navigates (Milestone 4), the same controls stay: the
 template also carries CarPlay's guidance (CarPlayGuidanceController), and
 recentre goes back to following the car.

 Without a map (no Mapbox settings) the template keeps only the name.
 */
final class CarPlayMapTemplateController: NSObject, CPMapTemplateDelegate {
  /// Panning mode's arrow buttons and knob, as fractions of the map's size
  enum Pan {
    /// Each time CarPlay reports the direction (repeated while an arrow is held)
    static let heldStep: CGFloat = 0.1
    /// Once more when it's released, so a tap always moves the map visibly
    static let releaseStep: CGFloat = 0.25
  }

  let template = CPMapTemplate()
  private weak var map: CarPlayMapViewController?
  private var dragUpdates = 0
  private var dragDistance: CGPoint = .zero

  init(map: CarPlayMapViewController?) {
    self.map = map
    super.init()
    template.mapDelegate = self
    // Kept on screen while there's nothing else in the bar yet
    template.automaticallyHidesNavigationBar = false
    template.leadingNavigationBarButtons = [CPBarButton(title: "Derwent") { _ in
      templateLog.notice("Derwent button tapped")
    }]
    if map != nil {
      template.mapButtons = [
        Self.mapButton("arrow.up.and.down.and.arrow.left.and.right") { [weak self] in
          self?.template.showPanningInterface(animated: true)
        },
        Self.mapButton("plus.magnifyingglass") { [weak self] in self?.map?.zoom(by: 1) },
        Self.mapButton("minus.magnifyingglass") { [weak self] in self?.map?.zoom(by: -1) },
      ]
      template.trailingNavigationBarButtons = [recenterButton()]
    }
  }

  private static func mapButton(_ symbol: String, action: @escaping () -> Void) -> CPMapButton {
    let button = CPMapButton { _ in action() }
    button.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold))
    return button
  }

  private func recenterButton() -> CPBarButton {
    CPBarButton(image: UIImage(systemName: "location.fill") ?? UIImage()) { [weak self] _ in self?.map?.recenter() }
  }

  /// How far the map's content moves for one step looking `direction`
  /// (screen points): looking right moves it left, looking up moves it down
  static func panOffset(_ direction: CPMapTemplate.PanDirection, step: CGFloat, in size: CGSize) -> CGPoint {
    var x: CGFloat = 0
    var y: CGFloat = 0
    if direction.contains(.left) { x += 1 }
    if direction.contains(.right) { x -= 1 }
    if direction.contains(.up) { y += 1 }
    if direction.contains(.down) { y -= 1 }
    return CGPoint(x: x * step * size.width, y: y * step * size.height)
  }

  private func pan(_ direction: CPMapTemplate.PanDirection, step: CGFloat) {
    guard let map else { return }
    map.move(by: Self.panOffset(direction, step: step, in: map.visibleSize))
  }

  // MARK: - Panning mode

  func mapTemplateDidShowPanningInterface(_ mapTemplate: CPMapTemplate) {
    templateLog.notice("CarPlay panning mode shown")
    mapTemplate.trailingNavigationBarButtons = [
      CPBarButton(title: "Done") { [weak mapTemplate] _ in mapTemplate?.dismissPanningInterface(animated: true) },
      recenterButton(),
    ]
  }

  func mapTemplateDidDismissPanningInterface(_ mapTemplate: CPMapTemplate) {
    templateLog.notice("CarPlay panning mode dismissed")
    // The map stays where it was moved to
    mapTemplate.trailingNavigationBarButtons = [recenterButton()]
  }

  func mapTemplate(_ mapTemplate: CPMapTemplate, panBeganWith direction: CPMapTemplate.PanDirection) {
    templateLog.notice("CarPlay pan began: \(direction.rawValue, privacy: .public)")
  }

  func mapTemplate(_ mapTemplate: CPMapTemplate, panWith direction: CPMapTemplate.PanDirection) {
    pan(direction, step: Pan.heldStep)
  }

  func mapTemplate(_ mapTemplate: CPMapTemplate, panEndedWith direction: CPMapTemplate.PanDirection) {
    templateLog.notice("CarPlay pan ended: \(direction.rawValue, privacy: .public)")
    pan(direction, step: Pan.releaseStep)
  }

  // MARK: - Dragging on a touch screen

  func mapTemplateDidBeginPanGesture(_ mapTemplate: CPMapTemplate) {
    templateLog.notice("CarPlay drag began")
    dragUpdates = 0
    dragDistance = .zero
  }

  /// Each update's translation is applied as the movement since the previous
  /// update, as the Mapbox Navigation SDK's CarPlay map and other CarPlay
  /// maps apply it (Apple doesn't say). The map follows the finger.
  func mapTemplate(_ mapTemplate: CPMapTemplate, didUpdatePanGestureWithTranslation translation: CGPoint, velocity: CGPoint) {
    dragUpdates += 1
    dragDistance.x += translation.x
    dragDistance.y += translation.y
    map?.move(by: translation)
  }

  func mapTemplate(_ mapTemplate: CPMapTemplate, didEndPanGestureWithVelocity velocity: CGPoint) {
    templateLog.notice("CarPlay drag ended: \(self.dragUpdates, privacy: .public) updates, moved \(Double(self.dragDistance.x), format: .fixed(precision: 0), privacy: .public), \(Double(self.dragDistance.y), format: .fixed(precision: 0), privacy: .public) points")
  }
}
