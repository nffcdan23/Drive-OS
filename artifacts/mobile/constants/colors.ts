/**
 * DriveOS Design Tokens
 * Warm off-white surfaces, charcoal text, warm orange/coral accents.
 */

const colors = {
  light: {
    // Legacy aliases
    text: '#1C1C1E',
    tint: '#F4631A',

    // Core surfaces
    background: '#FAF9F7',
    foreground: '#1C1C1E',

    // Cards
    card: '#FFFFFF',
    cardForeground: '#1C1C1E',

    // Primary — warm orange
    primary: '#F4631A',
    primaryForeground: '#FFFFFF',

    // Secondary
    secondary: '#F0EDE8',
    secondaryForeground: '#1C1C1E',

    // Muted
    muted: '#F0EDE8',
    mutedForeground: '#8A8680',

    // Accent — coral
    accent: '#FF4E3A',
    accentForeground: '#FFFFFF',

    // Destructive
    destructive: '#ef4444',
    destructiveForeground: '#ffffff',

    // Borders and inputs
    border: '#E8E4DE',
    input: '#E8E4DE',
  },

  dark: {
    text: '#F0EFE8',
    tint: '#F4631A',

    background: '#0F0F10',
    foreground: '#F0EFE8',

    card: '#1A1A1C',
    cardForeground: '#F0EFE8',

    primary: '#F4631A',
    primaryForeground: '#FFFFFF',

    secondary: '#252527',
    secondaryForeground: '#F0EFE8',

    muted: '#252527',
    mutedForeground: '#888888',

    accent: '#FF4E3A',
    accentForeground: '#FFFFFF',

    destructive: '#ef4444',
    destructiveForeground: '#ffffff',

    border: '#2C2C2E',
    input: '#2C2C2E',
  },

  // Border radius — rounded but not pill
  radius: 12,
};

export default colors;
