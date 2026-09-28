import React, { useState } from 'react';
import { APP_NAME } from '@/constants/brand';
import {
  ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useAuth } from '@/context/AuthContext';
import { describeAuthError, MIN_PASSWORD_LENGTH, validateCredentials } from '@/lib/backend/auth';
import { cockpit } from '@/constants/colors';
import { useColors } from '@/hooks/useColors';
import { backendEnv } from '@/lib/backendClient';

type Mode = 'signin' | 'signup' | 'forgot' | 'check-email' | 'reset-sent';

export default function SignInScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { signIn, signUp, signInWithApple, signInWithGoogle, requestPasswordReset, appleAvailable } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<null | 'email' | 'apple' | 'google'>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: 'email' | 'apple' | 'google', fn: () => Promise<void>) {
    setError(null);
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(null);
    }
  }

  const submit = () => run('email', async () => {
    if (mode === 'forgot') {
      const problem = validateCredentials(email, 'x', false);
      if (problem) { setError(problem); return; }
      await requestPasswordReset(email);
      setMode('reset-sent');
      return;
    }
    const problem = validateCredentials(email, password, mode === 'signup');
    if (problem) { setError(problem); return; }
    if (mode === 'signup') {
      const r = await signUp(email, password, name.trim() || undefined);
      if (r.needsConfirmation) setMode('check-email');
    } else {
      await signIn(email, password);
    }
  });

  const s = styles(colors, insets.top, insets.bottom);
  const title = mode === 'signup' ? 'Create your account' : mode === 'forgot' ? 'Reset your password' : `Sign in to ${APP_NAME}`;

  if (mode === 'check-email' || mode === 'reset-sent') {
    return (
      <View style={[s.container, s.centered]}>
        <Ionicons name="mail-unread-outline" size={48} color={colors.primary} />
        <Text style={s.title}>Check your email</Text>
        <Text style={s.body}>
          {mode === 'check-email'
            ? `We sent a confirmation link to ${email.trim()}. Open it on this phone to finish creating your account.`
            : `If an account exists for ${email.trim()}, we sent a link to reset its password.`}
        </Text>
        <TouchableOpacity style={s.linkBtn} onPress={() => { setMode('signin'); setPassword(''); }}>
          <Text style={s.link}>Back to sign in</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <Text style={s.brand}>{APP_NAME}</Text>
      <Text style={s.title}>{title}</Text>
      {backendEnv && backendEnv.appEnv !== 'production' ? (
        <Text style={s.envBadge}>{backendEnv.appEnv.toUpperCase()} SERVER</Text>
      ) : null}

      {mode !== 'forgot' ? (
        <View style={s.providers}>
          {Platform.OS === 'ios' && appleAvailable ? (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={mode === 'signup' ? AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP : AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
              cornerRadius={cockpit.radius.control}
              style={s.appleBtn}
              onPress={() => { if (!busy) void run('apple', signInWithApple); }}
            />
          ) : null}
          <TouchableOpacity style={s.providerBtn} disabled={!!busy} onPress={() => run('google', signInWithGoogle)} accessibilityRole="button">
            {busy === 'google' ? <ActivityIndicator color={colors.foreground} /> : (
              <>
                <Ionicons name="logo-google" size={18} color={colors.foreground} />
                <Text style={s.providerText}>Continue with Google</Text>
              </>
            )}
          </TouchableOpacity>
          <View style={s.dividerRow}>
            <View style={s.divider} /><Text style={s.dividerText}>or use email</Text><View style={s.divider} />
          </View>
        </View>
      ) : null}

      {mode === 'signup' ? (
        <TextInput style={s.input} placeholder="Your name (optional)" placeholderTextColor={colors.mutedForeground}
          value={name} onChangeText={setName} autoCapitalize="words" textContentType="name" maxLength={50} />
      ) : null}
      <TextInput style={s.input} placeholder="Email" placeholderTextColor={colors.mutedForeground}
        value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
        textContentType="emailAddress" autoComplete="email" accessibilityLabel="Email" />
      {mode !== 'forgot' ? (
        <View style={s.passwordRow}>
          <TextInput style={[s.input, s.passwordInput]} placeholder={mode === 'signup' ? `Password (${MIN_PASSWORD_LENGTH}+ characters)` : 'Password'}
            placeholderTextColor={colors.mutedForeground} value={password} onChangeText={setPassword}
            secureTextEntry={!showPassword} autoCapitalize="none" autoCorrect={false}
            textContentType={mode === 'signup' ? 'newPassword' : 'password'} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            accessibilityLabel="Password" onSubmitEditing={submit} />
          <TouchableOpacity style={s.eye} onPress={() => setShowPassword((v) => !v)} accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}>
            <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      ) : null}

      {error ? <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text> : null}

      <TouchableOpacity style={s.primaryBtn} disabled={!!busy} onPress={submit} accessibilityRole="button">
        {busy === 'email' ? <ActivityIndicator color={colors.primaryForeground} /> : (
          <Text style={s.primaryText}>{mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Sign in'}</Text>
        )}
      </TouchableOpacity>

      {mode === 'signin' ? (
        <>
          <TouchableOpacity style={s.linkBtn} onPress={() => { setMode('forgot'); setError(null); }}>
            <Text style={s.link}>Forgot password?</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.linkBtn} onPress={() => { setMode('signup'); setError(null); }}>
            <Text style={s.body}>New to {APP_NAME}? <Text style={s.link}>Create an account</Text></Text>
          </TouchableOpacity>
        </>
      ) : (
        <TouchableOpacity style={s.linkBtn} onPress={() => { setMode('signin'); setError(null); }}>
          <Text style={s.body}>{mode === 'signup' ? 'Already have an account? ' : ''}<Text style={s.link}>Back to sign in</Text></Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = (c: ReturnType<typeof useColors>, top: number, bottom: number) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  centered: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  content: { paddingTop: top + 48, paddingBottom: bottom + 32, paddingHorizontal: 24, gap: 12, maxWidth: 480, width: '100%', alignSelf: 'center' },
  brand: { color: c.primary, fontFamily: cockpit.type.display, fontSize: 34, letterSpacing: 1 },
  title: { color: c.foreground, fontFamily: cockpit.type.label, fontSize: 22, marginBottom: 4, textAlign: 'left' },
  body: { color: c.mutedForeground, fontFamily: cockpit.type.body, fontSize: 15, textAlign: 'center', lineHeight: 21 },
  envBadge: { alignSelf: 'flex-start', color: c.primaryForeground, backgroundColor: c.primary, fontFamily: cockpit.type.label, fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: 'hidden' },
  providers: { gap: 12, marginTop: 8 },
  appleBtn: { height: cockpit.touch, width: '100%' },
  providerBtn: {
    height: cockpit.touch, borderRadius: cockpit.radius.control, borderWidth: 1, borderColor: c.border, backgroundColor: c.card,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  providerText: { color: c.foreground, fontFamily: cockpit.type.label, fontSize: 16 },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 4 },
  divider: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: c.border },
  dividerText: { color: c.mutedForeground, fontFamily: cockpit.type.body, fontSize: 13 },
  input: {
    height: cockpit.touch, borderRadius: cockpit.radius.control, borderWidth: 1, borderColor: c.input, backgroundColor: c.card,
    color: c.foreground, paddingHorizontal: 14, fontFamily: cockpit.type.body, fontSize: 16,
  },
  passwordRow: { justifyContent: 'center' },
  passwordInput: { paddingRight: 48 },
  eye: { position: 'absolute', right: 8, height: cockpit.touch, width: 40, alignItems: 'center', justifyContent: 'center' },
  error: { color: c.destructive, fontFamily: cockpit.type.body, fontSize: 14 },
  primaryBtn: { height: cockpit.touch, borderRadius: cockpit.radius.control, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  primaryText: { color: c.primaryForeground, fontFamily: cockpit.type.label, fontSize: 16 },
  linkBtn: { paddingVertical: 8, alignItems: 'center' },
  link: { color: c.primary, fontFamily: cockpit.type.label, fontSize: 15 },
});
