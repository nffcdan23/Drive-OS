# DriveOS — Driving Companion App

A mobile-first driving companion prototype for tracking journeys, managing your vehicle garage, coordinating convoys, and exploring scenic routes.

## Running the App

The app runs via Replit's managed Expo workflow. It should start automatically. To test on your phone:

1. Install **Expo Go** on your iPhone
2. Scan the QR code shown in the Replit URL bar

## Environment Variables & API Keys

All API keys use the `EXPO_PUBLIC_` prefix so they're available in the Expo bundle. Add them in Replit's Secrets panel.

| Variable | Purpose | Status |
|---|---|---|
| `EXPO_PUBLIC_MAPBOX_TOKEN` | Live Mapbox map tiles | Not connected — demo map shown |
| `EXPO_PUBLIC_WEATHER_API_KEY` | Real weather data | Not connected — mock data used |
| `EXPO_PUBLIC_DVLA_PROXY_URL` | Vehicle registration lookup | Not connected — test registrations only |
| `DVLA_API_KEY` | DVLA backend key (server-only, never frontend) | Not connected |

## Demo Mode

`constants/config.ts` controls demo mode. Set `DEMO_MODE: false` to switch to live data once APIs are connected.

## Test Registrations (DVLA Lookup Demo)

The following registrations work in the demo lookup:

- `AB12CDE` — 2003 MINI Cooper R50
- `YD19XKL` — 2019 BMW 3 Series 320d
- `LK68JPN` — 2018 Volkswagen Golf GTI Mk7
- `FV65SOM` — 2015 Ford Fiesta ST
- `EK22TXW` — 2022 Porsche Cayman 718

All other registrations return "Live vehicle lookup is not connected."

## Data Storage

All data is stored locally with `AsyncStorage`. No server required for the prototype.

## Future Integrations

- **OBD2 Dongle** — real-time vehicle diagnostics via Bluetooth
- **HUD Display** — heads-up display integration
- **DVLA VES** — vehicle details from number plate via secure backend proxy
- **Backend database** — for multi-device sync and social features
