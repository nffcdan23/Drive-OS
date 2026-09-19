import colors from "@/constants/colors";
/** The cockpit has a deliberate dark appearance, independent of device theme. */
export function useColors() {
  return { ...colors.dark, radius: colors.radius };
}
