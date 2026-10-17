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
 - Once the template is shown: turn-by-turn guidance for the navigation
   session running on the iPhone, including one already under way
   (CarPlayGuidanceController).
 - Disconnect: the map, template, guidance and interface controller are
   released. The iPhone's navigation carries on.

 Nothing here starts React Native or changes the iPhone app's navigation,
 recording or account: guidance only shows the copy of the iPhone's
 navigation session it's handed (CarPlayNavigationStore).
 */
@objc(DerwentCarPlaySceneDelegate)
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  private var interfaceController: CPInterfaceController?
  private var carWindow: CPWindow?
  private var templateController: CarPlayMapTemplateController?
  private var guidance: CarPlayGuidanceController?

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
    let guidance = CarPlayGuidanceController(template: templateController.template, map: map)
    self.guidance = guidance
    interfaceController.setRootTemplate(templateController.template, animated: false) { [weak self, weak guidance] success, error in
      if let error {
        carPlayLog.error("CarPlay root template failed: \(error.localizedDescription, privacy: .public)")
      } else {
        carPlayLog.notice("CarPlay root template shown: \(success, privacy: .public)")
      }
      // Guidance needs the map template on screen; not if CarPlay has gone meanwhile
      DispatchQueue.main.async {
        guard success, let guidance, self?.guidance === guidance else { return }
        guidance.attach()
      }
    }
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnect interfaceController: CPInterfaceController,
    from window: CPWindow
  ) {
    carPlayLog.notice("CarPlay disconnected")
    guidance?.detach()
    guidance = nil
    window.rootViewController = nil
    templateController = nil
    self.interfaceController = nil
    carWindow = nil
  }
}
