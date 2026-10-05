/**
 * Building blocks for the sign-in screen: frosted glass buttons and fields
 * over the full-screen artwork, and the cyan primary action.
 */
import React, { forwardRef } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type TextInputProps,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Path } from "react-native-svg";
import { GlassButton, GlassSurface } from "@/components/Glass";

export const auth = {
  text: "#FFFFFF",
  muted: "rgba(226,232,238,0.72)",
  placeholder: "rgba(226,232,238,0.6)",
  cyan: "#3FD6F5",
  border: "rgba(255,255,255,0.22)",
  error: "#FF8A80",
  height: 54,
  radius: 27,
};

/** Google's four-colour "G", as their brand guidelines require. */
export function GoogleLogo({ size = 22 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </Svg>
  );
}

/** "Continue with Apple / Google": logo left, label centred, chevron right. */
export function ProviderButton({
  icon,
  label,
  busy,
  disabled,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <GlassButton
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.pill, styles.provider, disabled && !busy && styles.dimmed]}
    >
      <View style={styles.providerIcon}>{icon}</View>
      <Text numberOfLines={1} style={styles.providerText} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
      <View style={styles.providerEnd}>
        {busy ? (
          <ActivityIndicator color={auth.text} />
        ) : (
          <Ionicons name="chevron-forward" size={20} color={auth.muted} />
        )}
      </View>
    </GlassButton>
  );
}

/** A frosted text field with a leading icon and an optional trailing control. */
export const AuthField = forwardRef<
  TextInput,
  TextInputProps & {
    icon: React.ComponentProps<typeof Ionicons>["name"];
    trailing?: React.ReactNode;
  }
>(function AuthField({ icon, trailing, style, ...props }, ref) {
  return (
    <GlassSurface style={[styles.pill, styles.field]}>
      <Ionicons name={icon} size={21} color={auth.muted} />
      <TextInput
        ref={ref}
        placeholderTextColor={auth.placeholder}
        selectionColor={auth.cyan}
        keyboardAppearance="dark"
        maxFontSizeMultiplier={1.3}
        style={[styles.input, style]}
        {...props}
      />
      {trailing}
    </GlassSurface>
  );
});

export function Checkbox({
  checked,
  label,
  onChange,
  disabled,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      hitSlop={8}
      style={styles.checkRow}
    >
      <View style={[styles.box, checked && styles.boxOn]}>
        {checked && <Ionicons name="checkmark" size={15} color="#04121B" />}
      </View>
      <Text style={styles.checkText} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/** The cyan "Log in" pill. */
export function PrimaryButton({
  label,
  busy,
  disabled,
  onPress,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <View style={[styles.primaryGlow, disabled && !busy && styles.dimmed]}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled, busy }}
        activeOpacity={0.85}
        disabled={disabled}
        onPress={onPress}
        style={styles.primary}
      >
        <LinearGradient
          colors={["#6FE6FF", "#2CC9F2", "#12B2E8"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        {busy ? (
          <ActivityIndicator color="#04121B" />
        ) : (
          <>
            <Text style={styles.primaryText} maxFontSizeMultiplier={1.3}>
              {label}
            </Text>
            <Ionicons
              name="arrow-forward"
              size={24}
              color="#04121B"
              style={styles.primaryArrow}
            />
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}

export function OrDivider() {
  return (
    <View style={styles.dividerRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.divider} />
      <Text style={styles.dividerText}>OR</Text>
      <View style={styles.divider} />
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    height: auth.height,
    borderRadius: auth.radius,
    borderColor: auth.border,
    borderTopColor: "rgba(255,255,255,0.32)",
  },
  dimmed: { opacity: 0.5 },
  provider: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 56,
  },
  providerIcon: {
    position: "absolute",
    left: 22,
    width: 26,
    alignItems: "center",
  },
  providerText: {
    color: auth.text,
    fontSize: 17,
    fontWeight: "600",
  },
  providerEnd: {
    position: "absolute",
    right: 20,
    width: 24,
    alignItems: "center",
  },
  field: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 20,
    paddingRight: 8,
    gap: 14,
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    color: auth.text,
    fontSize: 17,
    paddingRight: 12,
  },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  boxOn: { backgroundColor: auth.cyan, borderColor: auth.cyan },
  checkText: { color: auth.text, fontSize: 15 },
  primaryGlow: {
    borderRadius: 30,
    shadowColor: "#18C2F0",
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  primary: {
    height: 58,
    borderRadius: 30,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: {
    color: "#04121B",
    fontSize: 19,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  primaryArrow: { position: "absolute", right: 26 },
  dividerRow: { flexDirection: "row", alignItems: "center", gap: 18 },
  divider: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.45)",
  },
  dividerText: {
    color: auth.muted,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 1,
  },
});
