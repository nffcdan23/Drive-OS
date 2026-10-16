import UIKit

/**
 The CarPlay window's content until the real map arrives (Milestone 3): the
 Derwent dark background with a faint grid, so it reads as an empty map.
 Map content only: no text, buttons or alerts (Apple: a navigation app's
 window draws only its map; controls come from templates). No location,
 no map SDK, no network.
 */
final class CarPlayPlaceholderViewController: UIViewController {
  override func loadView() {
    view = PlaceholderMapView()
  }
}

private final class PlaceholderMapView: UIView {
  /// Derwent's dark background (the iOS splash colour in app.json)
  private static let background = UIColor(red: 0x07 / 255, green: 0x09 / 255, blue: 0x0C / 255, alpha: 1)
  private static let gridLine = UIColor(white: 1, alpha: 0.06)
  private static let gridSpacing: CGFloat = 48

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = Self.background
    contentMode = .redraw
    isUserInteractionEnabled = false
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not used")
  }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    context.setStrokeColor(Self.gridLine.cgColor)
    context.setLineWidth(1)
    var x = Self.gridSpacing
    while x < bounds.width {
      context.move(to: CGPoint(x: x, y: 0))
      context.addLine(to: CGPoint(x: x, y: bounds.height))
      x += Self.gridSpacing
    }
    var y = Self.gridSpacing
    while y < bounds.height {
      context.move(to: CGPoint(x: 0, y: y))
      context.addLine(to: CGPoint(x: bounds.width, y: y))
      y += Self.gridSpacing
    }
    context.strokePath()
  }
}
