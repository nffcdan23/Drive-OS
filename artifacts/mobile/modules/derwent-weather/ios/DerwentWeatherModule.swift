import CoreLocation
import ExpoModulesCore
import WeatherKit

/// Current weather from Apple WeatherKit for the drive screen
/// (modules/derwent-weather/index.ts). Signed requests come from the app's
/// WeatherKit entitlement; there are no keys in the app.
public class DerwentWeatherModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DerwentWeather")

    /// The current conditions where the driver is: temperature in Celsius,
    /// the condition's SF Symbol and its localised description.
    AsyncFunction("currentWeather") { (latitude: Double, longitude: Double) async throws -> [String: Any] in
      let location = CLLocation(latitude: latitude, longitude: longitude)
      let current = try await WeatherService.shared.weather(for: location, including: .current)
      return [
        "temperatureC": current.temperature.converted(to: .celsius).value,
        "symbolName": current.symbolName,
        "condition": current.condition.description,
        "isDaylight": current.isDaylight,
        "date": current.date.timeIntervalSince1970 * 1000,
      ]
    }

    /// Apple's required attribution: the Apple Weather mark and the legal
    /// page listing the other data sources.
    AsyncFunction("attribution") { () async throws -> [String: Any] in
      let attribution = try await WeatherService.shared.attribution
      return [
        "serviceName": attribution.serviceName,
        "legalPageURL": attribution.legalPageURL.absoluteString,
        "combinedMarkDarkURL": attribution.combinedMarkDarkURL.absoluteString,
        "combinedMarkLightURL": attribution.combinedMarkLightURL.absoluteString,
      ]
    }
  }
}
