/**
 * Landing route for links that return to the app from Supabase Auth
 * (email confirmation, password reset, Google). AuthContext completes the
 * sign-in from the URL; this screen only shows progress or the error.
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useGlobalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { useColors } from '@/hooks/useColors';
import { cockpit } from '@/constants/colors';

export default function AuthCallback() {
  const colors = useColors();
  const router = useRouter();
  const params = useGlobalSearchParams<{ error_description?: string }>();
  const { session } = useAuth();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (session) router.replace('/');
  }, [session, router]);

  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), 10_000);
    return () => clearTimeout(t);
  }, []);

  const error = params.error_description ? String(params.error_description).replace(/\+/g, ' ') : null;
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {error || timedOut ? (
        <>
          <Text style={[styles.text, { color: colors.foreground }]}>
            {error ?? 'This link could not be used. It may have expired or been opened on a different device.'}
          </Text>
          <TouchableOpacity onPress={() => router.replace('/sign-in')}>
            <Text style={[styles.link, { color: colors.primary }]}>Back to sign in</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <ActivityIndicator color={colors.primary} />
          <Text style={[styles.text, { color: colors.mutedForeground }]}>Signing you in…</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32 },
  text: { fontFamily: cockpit.type.body, fontSize: 16, textAlign: 'center' },
  link: { fontFamily: cockpit.type.label, fontSize: 16 },
});
