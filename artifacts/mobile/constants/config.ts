// DriveOS Configuration
// Set DEMO_MODE = false when connecting real APIs

export const CONFIG = {
  DEMO_MODE: true,

  // Map API Keys — set in .env as EXPO_PUBLIC_MAPBOX_TOKEN
  MAPBOX_TOKEN: process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? null,

  // Weather API — set in .env as EXPO_PUBLIC_WEATHER_API_KEY
  WEATHER_API_KEY: process.env.EXPO_PUBLIC_WEATHER_API_KEY ?? null,

  // DVLA Vehicle Enquiry Service — NEVER expose in frontend; use backend proxy
  // Backend env: DVLA_API_KEY
  DVLA_LOOKUP_URL: process.env.EXPO_PUBLIC_DVLA_PROXY_URL ?? null,

  // Default demo location — Lake District, England
  DEMO_REGION: {
    latitude: 54.4609,
    longitude: -3.0886,
    latitudeDelta: 0.05,
    longitudeDelta: 0.05,
  },

  // Demo weather (mock until real API connected)
  DEMO_WEATHER: {
    temperature: 17,
    condition: 'Partly Cloudy',
    icon: 'partly-sunny-outline' as const,
  },
};

// Test registrations for demo DVLA lookup
// Real lookup will NOT return data for registrations not on this list
export const TEST_REGISTRATIONS: Record<string, {
  make: string; model: string; year: number; colour: string; fuelType: string; engine: string;
}> = {
  'AB12CDE': { make: 'MINI', model: 'Cooper R50', year: 2003, colour: 'British Racing Green', fuelType: 'petrol', engine: '1.6L' },
  'YD19XKL': { make: 'BMW', model: '3 Series 320d', year: 2019, colour: 'Alpine White', fuelType: 'diesel', engine: '2.0L' },
  'LK68JPN': { make: 'Volkswagen', model: 'Golf GTI Mk7', year: 2018, colour: 'Deep Black Pearl', fuelType: 'petrol', engine: '2.0L TSI' },
  'FV65SOM': { make: 'Ford', model: 'Fiesta ST', year: 2015, colour: 'Candy Red', fuelType: 'petrol', engine: '1.6L EcoBoost' },
  'EK22TXW': { make: 'Porsche', model: 'Cayman 718', year: 2022, colour: 'Carrara White Metallic', fuelType: 'petrol', engine: '2.0L Turbo' },
};
