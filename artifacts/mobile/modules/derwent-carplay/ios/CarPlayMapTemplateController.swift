import CarPlay
import UIKit
import os

private let templateLog = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Derwent", category: "CarPlay")

/**
 The root CPMapTemplate and its controls (Milestone 3): only what makes sense
 before navigation is connected.

 - Navigation bar: "Derwent" (the map template has no title; a bar button is
   the supported place for the name), and "Done" while panning (Apple: the
   app must provide the button that ends panning).
 - Map buttons (Apple allows up to four): zoom in, zoom out, recentre, pan.
 - Panning: the arrow buttons / knob in panning mode, and drags on the screen.

 Without a map (no Mapbox settings) the template keeps only the name.
 */
final class CarPlayMapTemplateController: NSObject, CPMapTemplateDelegate {
  let template = CPMapTemplate()
  private weak var map: CarPlayMapViewController?
  private var lastDragTranslation: CGPoint = .zero

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
        Self.mapButton("plus.magnifyingglass") { [weak self] in self?.map?.zoom(by: 1) },
        Self.mapButton("minus.magnifyingglass") { [weak self] in self?.map?.zoom(by: -1) },
        Self.mapButton("location.fill") { [weak self] in self?.map?.recenter() },
        Self.mapButton("arrow.up.and.down.and.arrow.left.and.right") { [weak self] in
          self?.template.showPanningInterface(animated: true)
        },
      ]
    }
  }

  private static func mapButton(_ symbol: String, action: @escaping () -> Void) -> CPMapButton {
    let button = CPMapButton { _ in action() }
    button.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold))
    return button
  }

  // MARK: - Panning mode

  func mapTemplateDidShowPanningInterface(_ mapTemplate: CPMapTemplate) {
    mapTemplate.trailingNavigationBarButtons = [CPBarButton(title: "Done") { [weak mapTemplate] _ in
      mapTemplate?.dismissPanningInterface(animated: true)
    }]
  }

  func mapTemplateDidDismissPanningInterface(_ mapTemplate: CPMapTemplate) {
    mapTemplate.trailingNavigationBarButtons = []
  }

  func mapTemplate(_ mapTemplate: CPMapTemplate, panWith direction: CPMapTemplate.PanDirection) {
    var dx: CGFloat = 0
    var dy: CGFloat = 0
    if direction.contains(.left) { dx -= 1 }
    if direction.contains(.right) { dx += 1 }
    if direction.contains(.up) { dy -= 1 }
    if direction.contains(.down) { dy += 1 }
    map?.pan(dx, dy)
  }

  // MARK: - Dragging on a touch screen

  func mapTemplateDidBeginPanGesture(_ mapTemplate: CPMapTemplate) {
    lastDragTranslation = .zero
  }

  func mapTemplate(_ mapTemplate: CPMapTemplate, didUpdatePanGestureWithTranslation translation: CGPoint, velocity: CGPoint) {
    let delta = CGPoint(x: translation.x - lastDragTranslation.x, y: translation.y - lastDragTranslation.y)
    lastDragTranslation = translation
    map?.drag(by: delta)
  }

  func mapTemplate(_ mapTemplate: CPMapTemplate, didEndPanGestureWithVelocity velocity: CGPoint) {
    lastDragTranslation = .zero
  }
}
