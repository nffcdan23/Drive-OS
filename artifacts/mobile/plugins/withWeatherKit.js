/**
 * Apple WeatherKit for the Drive recording screen's weather card
 * (modules/derwent-weather, docs/WEATHERKIT.md).
 *
 * - Entitlements: com.apple.developer.weatherkit. WeatherKit requests are
 *   signed by the system for an app with this entitlement; there are no keys
 *   or secrets in the app or this repository.
 * - The App ID (uk.co.starscale.drive.staging) must have WeatherKit enabled
 *   in the Apple Developer portal (Capabilities AND App Services), or Xcode
 *   can't sign the build. See docs/WEATHERKIT.md.
 */
const { withEntitlementsPlist } = require('expo/config-plugins');

const WEATHERKIT_ENTITLEMENT = 'com.apple.developer.weatherkit';

function withWeatherKit(config) {
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults[WEATHERKIT_ENTITLEMENT] = true;
    return cfg;
  });
}

module.exports = withWeatherKit;
module.exports.WEATHERKIT_ENTITLEMENT = WEATHERKIT_ENTITLEMENT;
