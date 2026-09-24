/** Shown after opening a password-reset link: choose a new password. */
import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useAuth } from '@/context/AuthContext';
import { describeAuthError, MIN_PASSWORD_LENGTH } from '@/lib/backend/auth';
import { useColors } from '@/hooks/useColors';
import { cockpit } from '@/constants/colors';

export default function ResetPasswordScreen() {
  const colors = useColors();
  const { setNewPassword } = useAuth();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await setNewPassword(password);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.foreground }]}>Choose a new password</Text>
      <TextInput
        style={[styles.input, { color: colors.foreground, borderColor: colors.input, backgroundColor: colors.card }]}
        placeholder={`New password (${MIN_PASSWORD_LENGTH}+ characters)`} placeholderTextColor={colors.mutedForeground}
        secureTextEntry value={password} onChangeText={setPassword} textContentType="newPassword" autoComplete="new-password"
      />
      {error ? <Text style={{ color: colors.destructive, fontFamily: cockpit.type.body }}>{error}</Text> : null}
      <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary }]} onPress={save} disabled={busy}>
        {busy ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={[styles.btnText, { color: colors.primaryForeground }]}>Save password</Text>}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontFamily: cockpit.type.label, fontSize: 22 },
  input: { height: cockpit.touch, borderRadius: cockpit.radius.control, borderWidth: 1, paddingHorizontal: 14, fontSize: 16 },
  btn: { height: cockpit.touch, borderRadius: cockpit.radius.control, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontFamily: cockpit.type.label, fontSize: 16 },
});
