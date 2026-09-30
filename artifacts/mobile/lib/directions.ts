import { Alert, Linking, Platform } from "react-native";
import type { Coordinate } from "@/lib/backend/model";
import { describeError } from "@/lib/backend/http";

/** Use the platform's maps app for routing until in-app guidance is connected. */
export async function openDirections(destination: Coordinate | string) {
  const target =
    typeof destination === "string"
      ? destination.trim()
      : `${destination.latitude},${destination.longitude}`;
  if (!target) return;
  const url =
    Platform.OS === "ios"
      ? `https://maps.apple.com/?daddr=${encodeURIComponent(target)}&dirflg=d`
      : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(target)}&travelmode=driving`;
  try {
    await Linking.openURL(url);
  } catch (err) {
    Alert.alert("Could not open directions", describeError(err));
  }
}
