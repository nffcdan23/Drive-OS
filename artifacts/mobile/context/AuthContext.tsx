/**
 * Authentication state for the app: the Supabase session and the sign-in
 * methods (email + password, Sign in with Apple, Sign in with Google).
 * The session is kept in the device's secure keychain, so users stay signed
 * in across restarts; signing in on another phone gives the same account.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import * as AppleAuthentication from 'expo-apple-authentication';
import {
  AuthFlowError, completeFromUrl, oauthUrl, sendPasswordReset, signInWithAppleToken, signInWithEmail,
  signUpWithEmail, updatePassword, type Session,
} from '@/lib/backend/auth';
import { ep, supabase } from '@/lib/backendClient';

WebBrowser.maybeCompleteAuthSession();

/** Where Supabase sends users back to the app (must be allow-listed in Supabase Auth). */
export const authRedirectUrl = () => Linking.createURL('auth/callback');

interface AuthContextValue {
  session: Session | null;
  userId: string | null;
  email: string | null;
  /** True until the stored session has been read. */
  initialising: boolean;
  /** True after opening a password-reset link, until a new password is set. */
  recoveringPassword: boolean;
  appleAvailable: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName?: string) => Promise<{ needsConfirmation: boolean }>;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  setNewPassword: (password: string) => Promise<void>;
  handleAuthUrl: (url: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [initialising, setInitialising] = useState(true);
  const [recoveringPassword, setRecoveringPassword] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    if (!supabase) { setInitialising(false); return; }
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) { setSession(data.session); setInitialising(false); }
    }).catch(() => { if (mounted) setInitialising(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === 'PASSWORD_RECOVERY') setRecoveringPassword(true);
      if (event === 'SIGNED_OUT') setRecoveringPassword(false);
    });
    if (Platform.OS === 'ios') AppleAuthentication.isAvailableAsync().then(setAppleAvailable).catch(() => {});
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, []);

  const client = () => {
    if (!supabase) throw new AuthFlowError('This build is missing its Supabase configuration.');
    return supabase;
  };

  const handleAuthUrl = useCallback(async (url: string) => {
    const isRecovery = url.includes('type=recovery');
    const s = await completeFromUrl(client(), url);
    if (s && isRecovery) setRecoveringPassword(true);
  }, []);

  // Links opened while the app is running (email confirmation, password reset).
  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url.includes('auth/callback')) handleAuthUrl(url).catch(() => {});
    });
    Linking.getInitialURL().then((url) => {
      if (url?.includes('auth/callback')) handleAuthUrl(url).catch(() => {});
    }).catch(() => {});
    return () => sub.remove();
  }, [handleAuthUrl]);

  const signIn = useCallback(async (email: string, password: string) => {
    await signInWithEmail(client(), email, password);
  }, []);

  const signUp = useCallback(async (email: string, password: string, displayName?: string) => {
    const r = await signUpWithEmail(client(), email, password, authRedirectUrl(), displayName);
    return { needsConfirmation: r.needsConfirmation };
  }, []);

  const signInWithApple = useCallback(async () => {
    const rawNonce = Crypto.randomUUID() + Crypto.randomUUID();
    const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
    let credential: AppleAuthentication.AppleAuthenticationCredential;
    try {
      credential = await AppleAuthentication.signInAsync({
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
        nonce: hashedNonce,
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_REQUEST_CANCELED') return;
      throw err;
    }
    if (!credential.identityToken) throw new AuthFlowError('Apple did not return an identity token.');
    await signInWithAppleToken(client(), credential.identityToken, rawNonce);
    // Apple only shares the name on the very first sign-in; keep it.
    const name = [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(' ');
    if (name && ep) await ep.updateMe({ displayName: name.slice(0, 50) }).catch(() => {});
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const redirectTo = authRedirectUrl();
    const url = await oauthUrl(client(), 'google', redirectTo);
    const result = await WebBrowser.openAuthSessionAsync(url, redirectTo);
    if (result.type !== 'success') return; // cancelled or dismissed
    await completeFromUrl(client(), result.url);
  }, []);

  const requestPasswordReset = useCallback(async (email: string) => {
    await sendPasswordReset(client(), email, `${authRedirectUrl()}?type=recovery`);
  }, []);

  const setNewPassword = useCallback(async (password: string) => {
    await updatePassword(client(), password);
    setRecoveringPassword(false);
  }, []);

  const signOut = useCallback(async () => {
    // Local scope: signs out this device only; other devices stay signed in.
    await client().auth.signOut({ scope: 'local' });
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    session, userId: session?.user.id ?? null, email: session?.user.email ?? null, initialising, recoveringPassword,
    appleAvailable, signIn, signUp, signInWithApple, signInWithGoogle, requestPasswordReset, setNewPassword,
    handleAuthUrl, signOut,
  }), [session, initialising, recoveringPassword, appleAvailable, signIn, signUp, signInWithApple, signInWithGoogle,
    requestPasswordReset, setNewPassword, handleAuthUrl, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
