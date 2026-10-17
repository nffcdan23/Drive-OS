import DerwentCarPlay
import ExpoModulesCore

/// The iPhone's navigation session, handed to the CarPlay screen one way
/// (modules/derwent-carplay-feed/index.ts, lib/navigation/carPlay.ts). It
/// only passes the copy on, on the main thread, to the CarPlay pod's store,
/// which keeps the latest whether or not CarPlay is connected.
public class DerwentCarPlayFeedModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DerwentCarPlayFeed")

    /// What CarPlay shows (CarPlayGuidance), or null when navigation ends
    AsyncFunction("setGuidance") { (guidance: [String: Any]?) in
      CarPlayNavigationStore.shared.setGuidance(guidance)
    }.runOnQueue(.main)

    /// The line still to drive as [lng, lat, …], or nulls for none
    AsyncFunction("setRouteLine") { (routeId: String?, coordinates: [Double]?) in
      CarPlayNavigationStore.shared.setRouteLine(routeId: routeId, coordinates: coordinates)
    }.runOnQueue(.main)
  }
}
