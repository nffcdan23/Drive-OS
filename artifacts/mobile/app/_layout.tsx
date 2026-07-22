import React, { useEffect } from 'react';
import { View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { SyncBanner } from '@/components/SyncBanner';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { AppProvider, useApp } from '@/context/AppContext';

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="search" options={{ presentation: 'modal', headerShown: false, animation: 'slide_from_bottom' }} />
      <Stack.Screen name="drive-summary" options={{ presentation: 'modal', headerShown: false, animation: 'slide_from_bottom' }} />
      <Stack.Screen name="settings" options={{ headerShown: false, animation: 'slide_from_right' }} />
      <Stack.Screen name="journey/[id]" options={{ headerShown: false, animation: 'slide_from_right' }} />
      <Stack.Screen name="vehicle/[id]" options={{ headerShown: false, animation: 'slide_from_right' }} />
      <Stack.Screen name="messages" options={{ headerShown: false, animation: 'slide_from_right' }} />
      <Stack.Screen name="conversation/[id]" options={{ headerShown: false, animation: 'slide_from_right' }} />
      <Stack.Screen name="group/[id]" options={{ headerShown: false, animation: 'slide_from_right' }} />
      <Stack.Screen name="event/[id]" options={{ headerShown: false, animation: 'slide_from_right' }} />
    </Stack>
  );
}

/** Global sync banner rendered above all screens */
function GlobalSyncBanner() {
  const { syncStatus, retryJourneySync } = useApp();
  const visible = syncStatus !== 'idle';
  return (
    <SyncBanner
      visible={visible}
      status={syncStatus === 'syncing' ? 'syncing' : syncStatus === 'error' ? 'error' : 'waiting'}
      onRetry={retryJourneySync}
    />
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <ErrorBoundary>
            <QueryClientProvider client={queryClient}>
              <AppProvider>
                <View style={{ flex: 1 }}>
                  <RootLayoutNav />
                  <GlobalSyncBanner />
                </View>
              </AppProvider>
            </QueryClientProvider>
          </ErrorBoundary>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
