import CarPlay
import UIKit
import os

/// Logs to the Xcode console and Console.app (category "CarPlay"). A
/// file-level constant: usable from CarPlay's callbacks whatever their actor.
private let carPlayLog = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Derwent", category: "CarPlay")

/**
 Derwent's CarPlay scene: native only, no React Native.

 UIKit creates this delegate by name for the CarPlay scene that
 plugins/withCarPlay.js adds to Info.plist (UISceneDelegateClassName
 "DerwentCarPlaySceneDelegate"). The iPhone's own scene is Expo's
 EXExpoAppSceneDelegate and is untouched.

 - Connect: the CarPlay window shows the Mapbox map (CarPlayMapViewController)
   when Info.plist has the public Mapbox token and Derwent style
   (CarPlayMapSettings), else the placeholder; the root template is a
   CPMapTemplate with the controls in CarPlayMapTemplateController.
 - Disconnect: the map, template and interface controller are released.

 Nothing here starts React Native or touches the iPhone app's navigation,
 recording or account.
 */
@objc(DerwentCarPlaySceneDelegate)
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  private var interfaceController: CPInterfaceController?
  private var carWindow: CPWindow?
  private var templateController: CarPlayMapTemplateController?

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController,
    to window: CPWindow
  ) {
    carPlayLog.notice("CarPlay connected")
    self.interfaceController = interfaceController
    carWindow = window

    // The window only ever draws map content; controls are templates
    var map: CarPlayMapViewController?
    if let settings = CarPlayMapSettings.fromInfoPlist() {
      let controller = CarPlayMapViewController(settings: settings)
      window.rootViewController = controller
      map = controller
    } else {
      carPlayLog.notice("CarPlay map not configured (no public Mapbox token and style in Info.plist): placeholder shown")
      window.rootViewController = CarPlayPlaceholderViewController()
    }

    let templateController = CarPlayMapTemplateController(map: map)
    self.templateController = templateController
    interfaceController.setRootTemplate(templateController.template, animated: false) { success, error in
      if let error {
        carPlayLog.error("CarPlay root template failed: \(error.localizedDescription, privacy: .public)")
      } else {
        carPlayLog.notice("CarPlay root template shown: \(success, privacy: .public)")
      }
    }
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnect interfaceController: CPInterfaceController,
    from window: CPWindow
  ) {
    carPlayLog.notice("CarPlay disconnected")
    window.rootViewController = nil
    templateController = nil
    self.interfaceController = nil
    carWindow = nil
  }
}
