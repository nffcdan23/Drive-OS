/** Brand-neutral cockpit palette. Legacy aliases keep existing screens compatible. */
const graphite = {
  text: "#F3F5F7",
  tint: "#C48235",
  background: "#0A0D10",
  foreground: "#F3F5F7",
  card: "#141A20",
  cardForeground: "#F3F5F7",
  primary: "#C48235",
  primaryForeground: "#10161C",
  secondary: "#202831",
  secondaryForeground: "#F3F5F7",
  muted: "#202831",
  mutedForeground: "#A9B3BE",
  accent: "#C48235",
  accentForeground: "#FFFFFF",
  destructive: "#F07575",
  destructiveForeground: "#0A0D10",
  border: "#303B46",
  input: "#303B46",
  labelMuted: "#A9B3BE",
  surfaceBorder: "#303B46",
  warmShadow: "rgba(0,0,0,0.4)",
  tabInactive: "#A9B3BE",
  tabBarBg: "#10161C",
  scenicGreen: "#285449",
};
export const cockpit = {
  space: { xs: 4, sm: 8, md: 12, lg: 20, xl: 28 },
  radius: { control: 12, card: 20, sheet: 28 },
  type: {
    display: "Archivo_700Bold",
    body: "Inter_400Regular",
    label: "Inter_600SemiBold",
  },
  touch: 48,
};
export default { light: graphite, dark: graphite, radius: cockpit.radius.card };
