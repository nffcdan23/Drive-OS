import { Alert } from "react-native";
import { useApp } from "@/context/AppContext";
import { useAuth } from "@/context/AuthContext";
import { describeError } from "@/lib/backend/http";

export function useSignOut() {
  const { clearLocalData, hasUnsyncedWork, retrySync } = useApp();
  const { signOut } = useAuth();
  const perform = async () => {
    try {
      await clearLocalData();
      await signOut();
    } catch (err) {
      Alert.alert("Could not sign out", describeError(err));
    }
  };
  return () => {
    if (hasUnsyncedWork()) {
      Alert.alert(
        "Changes not uploaded yet",
        "Some changes or drives are still on this phone and haven't reached your account. Signing out now will lose them.",
        [
          {
            text: "Try to upload",
            onPress: () => {
              void retrySync();
            },
          },
          {
            text: "Sign out anyway",
            style: "destructive",
            onPress: () => {
              void perform();
            },
          },
          { text: "Cancel", style: "cancel" },
        ],
      );
    } else
      Alert.alert(
        "Sign out?",
        "Your data stays in your account. Sign in again on any phone to get it back.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Sign out",
            onPress: () => {
              void perform();
            },
          },
        ],
      );
  };
}
