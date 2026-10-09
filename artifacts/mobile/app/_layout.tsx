import "@/lib/polyfills";
import { APP_NAME } from "@/constants/brand";
import { MaterialProvider } from "@/components/Glass";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import {
  Archivo_400Regular,
  Archivo_700Bold,
} from "@expo-google-fonts/archivo";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { AppProvider, useApp } from "@/context/AppContext";
import LoadingScreen from "@/components/LoadingScreen";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { NavigationProvider } from "@/context/NavigationContext";
import { configError } from "@/lib/backendClient";

SplashScreen.preventAutoHideAsync();
// The loading screen hides the native splash once its artwork is showing;
// this is only a backstop (e.g. a render error before that happens).
setTimeout(() => { SplashScreen.hideAsync().catch(() => {}); }, 5000);

function AppStack({ signedIn, recovering }: { signedIn: boolean; recovering: boolean }) {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      {/* Signed out: only the sign-in screens exist. */}
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      </Stack.Protected>
      {/* Opened a password-reset link: choose a new password first. */}
      <Stack.Protected guard={signedIn && recovering}>
        <Stack.Screen name="reset-password" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !recovering}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="search"
          options={{ presentation: "modal", headerShown: false, animation: "slide_from_bottom" }}
        />
        <Stack.Screen
          name="drive-summary"
          options={{ presentation: "modal", headerShown: false, animation: "slide_from_bottom" }}
        />
        <Stack.Screen name="settings" options={{ headerShown: false, animation: "slide_from_right" }} />
        <Stack.Screen name="diagnostics" options={{ headerShown: false, animation: "slide_from_right" }} />
        <Stack.Screen name="journey/[id]" options={{ headerShown: false, animation: "slide_from_right" }} />
        <Stack.Screen name="vehicle/[id]" options={{ headerShown: false, animation: "slide_from_right" }} />
        <Stack.Screen name="messages" options={{ headerShown: false, animation: "slide_from_right" }} />
        <Stack.Screen name="conversation/[id]" options={{ headerShown: false, animation: "slide_from_right" }} />
        <Stack.Screen name="group/[id]" options={{ headerShown: false, animation: "slide_from_right" }} />
        <Stack.Screen name="event/[id]" options={{ headerShown: false, animation: "slide_from_right" }} />
      </Stack.Protected>
      <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
    </Stack>
  );
}

/** Start-up steps the loading screen follows, in order. */
type LaunchStep = "session" | "data" | "ready";
/** Where the navigator reports start-up steps to the loading screen. */
const LaunchStepContext = createContext<(step: LaunchStep) => void>(() => {});

/** Reports when the signed-in user's saved data has loaded. */
function DataLoaded({ onLoaded }: { onLoaded: () => void }) {
  const { isLoading } = useApp();
  useEffect(() => {
    if (!isLoading) onLoaded();
  }, [isLoading, onLoaded]);
  return null;
}

function RootLayoutNav() {
  const { userId, initialising, recoveringPassword } = useAuth();
  const onLaunchStep = useContext(LaunchStepContext);

  useEffect(() => {
    if (!initialising) onLaunchStep(userId ? "data" : "ready");
  }, [initialising, userId, onLaunchStep]);
  const dataLoaded = useCallback(() => onLaunchStep("ready"), [onLaunchStep]);

  if (initialising) return null;

  if (!userId) return <AppStack signedIn={false} recovering={false} />;

  // One provider per account: signing in as someone else starts from a clean slate.
  return (
    <AppProvider key={userId} userId={userId}>
      <NavigationProvider>
        <DataLoaded onLoaded={dataLoaded} />
        <View style={{ flex: 1 }}>
          <ConnectionBanner />
          <AppStack signedIn recovering={recoveringPassword} />
        </View>
      </NavigationProvider>
    </AppProvider>
  );
}

// How far along the bar is when each step starts.
const STEP_PROGRESS: Record<LaunchStep | "fonts", number> = {
  fonts: 0.12,
  session: 0.4,
  data: 0.7,
  ready: 1,
};

/** Shown instead of the app when a build lacks its Supabase/API settings. */
function ConfigErrorScreen({ message }: { message: string }) {
  useEffect(() => { SplashScreen.hideAsync(); }, []);
  return (
    <View style={styles.configError}>
      <Text style={styles.configTitle}>{APP_NAME} is not configured</Text>
      <Text style={styles.configText}>{message}</Text>
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Archivo_400Regular,
    Archivo_700Bold,
  });

  const fontsReady = fontsLoaded || !!fontError;
  // Only the first start-up drives the loading screen; later sign-ins don't.
  const [launchStep, setLaunchStep] = useState<LaunchStep>("session");
  const [showLoading, setShowLoading] = useState(true);
  const onLaunchStep = useCallback((step: LaunchStep) => {
    setLaunchStep((prev) => (STEP_PROGRESS[step] > STEP_PROGRESS[prev] ? step : prev));
  }, []);
  const loadingFinished = useCallback(() => setShowLoading(false), []);

  if (configError) {
    if (!fontsReady) return null;
    return <ConfigErrorScreen message={configError} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <ErrorBoundary>
              <AuthProvider>
                <MaterialProvider>
                  <View style={{ flex: 1 }}>
                    <StatusBar style="light" />
                    <LaunchStepContext.Provider value={onLaunchStep}>
                      {fontsReady ? <RootLayoutNav /> : null}
                    </LaunchStepContext.Provider>
                    {showLoading ? (
                      <LoadingScreen
                        progress={fontsReady ? STEP_PROGRESS[launchStep] : STEP_PROGRESS.fonts}
                        ready={fontsReady && launchStep === "ready"}
                        onFinished={loadingFinished}
                      />
                    ) : null}
                  </View>
                </MaterialProvider>
              </AuthProvider>
          </ErrorBoundary>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  configError: { flex: 1, backgroundColor: "#0A0D10", alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  configTitle: { color: "#F3F5F7", fontSize: 20, fontFamily: "Inter_600SemiBold" },
  configText: { color: "#A9B3BE", fontSize: 15, textAlign: "center", fontFamily: "Inter_400Regular" },
});
