/**
 * DriveOS Design Tokens
 * Warm off-white surfaces, charcoal text, warm orange/coral accents.
 * 1b/1c design system tokens added — do not remove legacy aliases.
 */

const colors = {
  light: {
    // Legacy aliases
    text: '#1C1C1E',
    tint: '#F4631A',

    // Core surfaces
    background: '#F7F4EE',
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
    mutedForeground: '#8A8375',

    // Accent — coral
    accent: '#FF4E3A',
    accentForeground: '#FFFFFF',

    // Destructive
    destructive: '#ef4444',
    destructiveForeground: '#ffffff',

    // Borders and inputs
    border: '#E8E4DE',
    input: '#E8E4DE',

    // 1b/1c design tokens
    labelMuted: '#A79E8C',          // caption / secondary label
    surfaceBorder: 'rgba(28,28,30,0.08)',  // subtle card border
    warmShadow: 'rgba(46,36,20,0.14)',     // warm brown card shadow
    tabInactive: '#A79E8C',         // inactive tab icon
    tabBarBg: 'rgba(247,244,238,0.85)',    // floating tab bar fill
    scenicGreen: '#1F4D3A',         // scenic route button
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
    mutedForeground: '#8A8680',

    accent: '#FF4E3A',
    accentForeground: '#FFFFFF',

    destructive: '#ef4444',
    destructiveForeground: '#ffffff',

    border: '#2C2C2E',
    input: '#2C2C2E',

    // 1b/1c design tokens
    labelMuted: '#6C6A66',
    surfaceBorder: 'rgba(255,255,255,0.07)',
    warmShadow: 'rgba(0,0,0,0.4)',
    tabInactive: '#6C6A66',
    tabBarBg: 'rgba(26,26,28,0.85)',
    scenicGreen: '#1F4D3A',
  },

  // Border radius — rounded but not pill
  radius: 12,
};

export default colors;
