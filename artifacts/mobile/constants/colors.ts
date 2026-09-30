/** Derwent graphite palette. Legacy aliases keep existing screens compatible. */
const graphite = {
  text: "#F3F5F7",
  tint: "#00CFE8",
  background: "#0A0D10",
  foreground: "#F3F5F7",
  card: "#141A20",
  cardForeground: "#F3F5F7",
  primary: "#00CFE8",
  primaryForeground: "#10161C",
  secondary: "#202831",
  secondaryForeground: "#F3F5F7",
  muted: "#202831",
  mutedForeground: "#A9B3BE",
  accent: "#00CFE8",
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
export const sectionAccent = {
  drive: "#00CFE8",
  drives: "#6CB9F4",
  garage: "#FFA052",
  social: "#39D9A0",
  profile: "#69DEBA",
};
export const cockpit = {
  space: { xs: 4, sm: 8, md: 12, lg: 20, xl: 28 },
  radius: { control: 12, card: 20, sheet: 28 },
  type: {
    display: "System",
    body: "System",
    label: "System",
  },
  touch: 48,
};
export default { light: graphite, dark: graphite, radius: cockpit.radius.card };
