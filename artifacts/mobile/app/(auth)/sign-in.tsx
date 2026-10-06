import React, { useRef, useState } from 'react';
import { APP_NAME } from '@/constants/brand';
import {
  Image, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/context/AuthContext';
import { describeAuthError, MIN_PASSWORD_LENGTH, validateCredentials } from '@/lib/backend/auth';
import { backendEnv } from '@/lib/backendClient';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { GlassSurface } from '@/components/Glass';
import AuthBackground from '@/components/auth/AuthBackground';
import {
  auth, authInput, AuthField, Checkbox, GoogleLogo, OrDivider, PrimaryButton, ProviderButton,
} from '@/components/auth/AuthUI';

type Mode = 'signin' | 'signup' | 'forgot' | 'check-email' | 'reset-sent';

const LOGO = require('@/assets/images/derwent-logo.png');

export default function SignInScreen() {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const {
    signIn, signUp, signInWithApple, signInWithGoogle, requestPasswordReset, appleAvailable, setKeepSignedIn,
  } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [keepSignedIn, setKeep] = useState(true);
  const [busy, setBusy] = useState<null | 'email' | 'apple' | 'google'>(null);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);

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

  // Applies to whichever sign-in follows, so it is set just before each one.
  const signInWith = (kind: 'apple' | 'google', fn: () => Promise<void>) =>
    run(kind, async () => { await setKeepSignedIn(keepSignedIn); await fn(); });

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
    await setKeepSignedIn(keepSignedIn);
    if (mode === 'signup') {
      const r = await signUp(email, password, name.trim() || undefined);
      if (r.needsConfirmation) setMode('check-email');
    } else {
      await signIn(email, password);
    }
  });

  const switchMode = (next: Mode) => { setMode(next); setError(null); };

  // Scales the branding down on shorter phones so the form keeps its room.
  const compact = height < 720;
  const logoSize = compact ? 92 : Math.min(150, Math.round(height * 0.16));
  const disabled = !!busy;
  const canSubmit = mode === 'forgot' ? !!email.trim() : !!email.trim() && !!password;
  const primaryLabel = mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Log in';

  return (
    <View style={styles.container}>
      <AuthBackground />
      <KeyboardAwareScrollViewCompat
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + (compact ? 12 : 28), paddingBottom: Math.max(insets.bottom, 16) + 12 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Branding */}
        <View style={[styles.brand, { minHeight: compact ? 210 : 280 }]}>
          {/* The logo as a frosted white mark; its cut-out lines show the artwork through. */}
          <Image
            source={LOGO}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
            style={{ width: logoSize * 1.05, height: logoSize, tintColor: '#EEF2F6', opacity: 0.94 }}
          />
          <Text accessibilityRole="header" style={[styles.wordmark, compact && styles.wordmarkCompact]} maxFontSizeMultiplier={1.1}>
            {APP_NAME.toUpperCase()}
          </Text>
          <Text style={styles.tagline} maxFontSizeMultiplier={1.1}>DRIVE   EXPLORE   CONNECT</Text>
          {backendEnv && backendEnv.appEnv !== 'production' ? (
            <Text style={styles.envBadge}>{backendEnv.appEnv.toUpperCase()} SERVER</Text>
          ) : null}
        </View>

        {mode === 'check-email' || mode === 'reset-sent' ? (
          <GlassSurface material="dense" style={styles.notice}>
            <Ionicons name="mail-unread-outline" size={40} color={auth.cyan} />
            <Text style={styles.noticeTitle}>Check your email</Text>
            <Text style={styles.noticeBody}>
              {mode === 'check-email'
                ? `We sent a confirmation link to ${email.trim()}. Open it on this phone to finish creating your account.`
                : `If an account exists for ${email.trim()}, we sent a link to reset its password.`}
            </Text>
            <TouchableOpacity style={styles.linkBtn} onPress={() => { switchMode('signin'); setPassword(''); }}>
              <Text style={styles.link}>Back to log in</Text>
            </TouchableOpacity>
          </GlassSurface>
        ) : (
          <View style={styles.form}>
            {mode === 'forgot' ? (
              <View style={styles.heading}>
                <Text style={styles.headingTitle}>Reset your password</Text>
                <Text style={styles.headingBody}>Enter your email and we'll send you a link to set a new one.</Text>
              </View>
            ) : (
              <>
                {Platform.OS === 'ios' && appleAvailable ? (
                  <ProviderButton
                    icon={<Ionicons name="logo-apple" size={26} color="#FFFFFF" />}
                    label="Continue with Apple"
                    busy={busy === 'apple'}
                    disabled={disabled}
                    onPress={() => signInWith('apple', signInWithApple)}
                  />
                ) : null}
                <ProviderButton
                  icon={<GoogleLogo />}
                  label="Continue with Google"
                  busy={busy === 'google'}
                  disabled={disabled}
                  onPress={() => signInWith('google', signInWithGoogle)}
                />
                <View style={styles.dividerWrap}><OrDivider /></View>
              </>
            )}

            {mode === 'signup' ? (
              <AuthField icon="person-outline">
                <TextInput
                  {...authInput}
                  placeholder="Your name (optional)"
                  value={name}
                  onChangeText={setName}
                  autoCapitalize="words"
                  textContentType="name"
                  maxLength={50}
                  editable={!disabled}
                  returnKeyType="next"
                  accessibilityLabel="Your name"
                />
              </AuthField>
            ) : null}
            <AuthField icon="mail-outline">
              <TextInput
                {...authInput}
                placeholder="Email address"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType={mode === 'signup' ? 'username' : 'emailAddress'}
                autoComplete="email"
                editable={!disabled}
                returnKeyType={mode === 'forgot' ? 'send' : 'next'}
                onSubmitEditing={() => (mode === 'forgot' ? submit() : passwordRef.current?.focus())}
                submitBehavior={mode === 'forgot' ? 'blurAndSubmit' : 'submit'}
                accessibilityLabel="Email address"
              />
            </AuthField>
            {mode !== 'forgot' ? (
              <AuthField
                icon="lock-closed-outline"
                trailing={
                  <TouchableOpacity
                    style={styles.eye}
                    onPress={() => setShowPassword((v) => !v)}
                    accessibilityRole="button"
                    accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                  >
                    <Ionicons name={showPassword ? 'eye-outline' : 'eye-off-outline'} size={22} color={auth.muted} />
                  </TouchableOpacity>
                }
              >
                <TextInput
                  {...authInput}
                  ref={passwordRef}
                  placeholder={mode === 'signup' ? `Password (${MIN_PASSWORD_LENGTH}+ characters)` : 'Password'}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType={mode === 'signup' ? 'newPassword' : 'password'}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  editable={!disabled}
                  returnKeyType="go"
                  onSubmitEditing={submit}
                  accessibilityLabel="Password"
                />
              </AuthField>
            ) : null}

            {mode !== 'forgot' ? (
              <View style={styles.optionsRow}>
                <Checkbox checked={keepSignedIn} onChange={setKeep} label="Keep me signed in" disabled={disabled} />
                {mode === 'signin' ? (
                  <TouchableOpacity onPress={() => switchMode('forgot')} disabled={disabled} hitSlop={8} accessibilityRole="button">
                    <Text style={styles.link}>Forgot password?</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}

            {error ? (
              <View style={styles.error} accessibilityLiveRegion="polite" accessibilityRole="alert">
                <Ionicons name="alert-circle" size={18} color={auth.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <View style={styles.primaryWrap}>
              <PrimaryButton label={primaryLabel} busy={busy === 'email'} disabled={disabled || !canSubmit} onPress={submit} />
            </View>

            {mode === 'signin' ? (
              <TouchableOpacity style={styles.linkBtn} onPress={() => switchMode('signup')} disabled={disabled} accessibilityRole="button">
                <Text style={styles.footer}>Don't have an account? <Text style={styles.link}>Sign up</Text></Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.linkBtn} onPress={() => switchMode('signin')} disabled={disabled} accessibilityRole="button">
                <Text style={styles.footer}>
                  {mode === 'signup' ? 'Already have an account? ' : ''}<Text style={styles.link}>{mode === 'signup' ? 'Log in' : 'Back to log in'}</Text>
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#05070A' },
  scroll: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: 22, width: '100%', maxWidth: 480, alignSelf: 'center' },
  brand: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 16 },
  wordmark: {
    color: '#F4F6F8', fontSize: 40, fontWeight: '600', letterSpacing: 14, marginTop: 18, marginRight: -14,
    textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 14, textShadowOffset: { width: 0, height: 2 },
  },
  wordmarkCompact: { fontSize: 32, letterSpacing: 11, marginTop: 12, marginRight: -11 },
  tagline: {
    color: 'rgba(236,240,244,0.82)', fontSize: 12, fontWeight: '500', letterSpacing: 4.5, marginTop: 14, marginRight: -4.5,
    textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 8,
  },
  envBadge: {
    marginTop: 14, color: auth.cyan, fontSize: 10, fontWeight: '700', letterSpacing: 1,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(63,214,245,0.5)', overflow: 'hidden',
  },
  form: { gap: 12 },
  heading: { gap: 6, marginBottom: 6 },
  headingTitle: { color: auth.text, fontSize: 22, fontWeight: '600' },
  headingBody: { color: auth.muted, fontSize: 15, lineHeight: 21 },
  dividerWrap: { paddingVertical: 6 },
  eye: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  optionsRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36, paddingHorizontal: 2, marginTop: 2,
  },
  link: { color: auth.cyan, fontSize: 15, fontWeight: '500' },
  error: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14,
    backgroundColor: 'rgba(40,10,10,0.6)', borderWidth: 1, borderColor: 'rgba(255,138,128,0.35)',
  },
  errorText: { flex: 1, color: '#FFD4CF', fontSize: 14, lineHeight: 19 },
  primaryWrap: { marginTop: 6 },
  linkBtn: { paddingVertical: 10, alignItems: 'center' },
  footer: { color: auth.muted, fontSize: 15, textAlign: 'center' },
  notice: { borderRadius: 28, padding: 24, alignItems: 'center', gap: 10 },
  noticeTitle: { color: auth.text, fontSize: 20, fontWeight: '600' },
  noticeBody: { color: auth.muted, fontSize: 15, lineHeight: 21, textAlign: 'center' },
});
