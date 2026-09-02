import { useColorScheme } from 'react-native';
import colors from '@/constants/colors';

/**
 * Returns the design tokens for the current color scheme.
 *
 * Picks the `light` or `dark` palette from constants/colors.ts based on the
 * device's appearance setting, and adds scheme-independent values like
 * `radius`. Both palettes define the same set of tokens.
 */
export function useColors() {
  const scheme = useColorScheme();
  const palette = scheme === 'dark' ? colors.dark : colors.light;
  return { ...palette, radius: colors.radius };
}
