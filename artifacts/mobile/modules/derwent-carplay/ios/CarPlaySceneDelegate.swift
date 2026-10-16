import CarPlay
import UIKit
import os

/// Logs to the Xcode console and Console.app (category "CarPlay"). A
/// file-level constant: usable from CarPlay's callbacks whatever their actor.
private let carPlayLog = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Derwent", category: "CarPlay")

/**
 Derwent's CarPlay scene (CarPlay Milestone 2): a minimal, native-only
 interface, to prove the app appears on the CarPlay home screen and launches.

 UIKit creates this delegate by name for the CarPlay scene that
 plugins/withCarPlay.js adds to Info.plist (UISceneDelegateClassName
 "DerwentCarPlaySceneDelegate"). The iPhone's own scene is Expo's
 EXExpoAppSceneDelegate and is untouched.

 - Connect: the CarPlay window shows the map placeholder (map content only,
   as Apple requires for a navigation app's window), and a CPMapTemplate is
   the root template, with "Derwent" as a navigation bar button.
 - Disconnect: the window, template and interface controller are released.

 Nothing here starts React Native, reads the location, or touches the
 iPhone app's navigation, recording or account.
 */
@objc(DerwentCarPlaySceneDelegate)
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  private var interfaceController: CPInterfaceController?
  private var carWindow: CPWindow?

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController,
    to window: CPWindow
  ) {
    carPlayLog.notice("CarPlay connected")
    self.interfaceController = interfaceController
    carWindow = window

    // The window only ever draws map content; controls are templates
    window.rootViewController = CarPlayPlaceholderViewController()

    let mapTemplate = CPMapTemplate()
    // A navigation bar button is the supported way to show a label on the
    // map template (it has no title of its own). Kept on screen while this
    // is only a placeholder.
    mapTemplate.leadingNavigationBarButtons = [CPBarButton(title: "Derwent") { _ in
      carPlayLog.notice("Derwent button tapped")
    }]
    mapTemplate.automaticallyHidesNavigationBar = false
    interfaceController.setRootTemplate(mapTemplate, animated: false) { success, error in
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
    self.interfaceController = nil
    carWindow = nil
  }
}
