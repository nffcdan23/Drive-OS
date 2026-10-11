/**
 * Report a road hazard: Report → a type, and it is sent. Two taps, nothing to
 * type, big targets. The position is the Drive screen's latest accepted GPS
 * fix, read at the moment the type is tapped (never a route-snapped point).
 *
 * After sending it says what happened ("Reported", or that it confirmed one
 * already there) and closes itself. If it can't be sent (offline, no current
 * location, too many reports) it says so and nothing is queued: a hazard
 * report from minutes ago is no use to anyone.
 */
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassButton, GlassSurface } from "@/components/Glass";
import { KeyboardAwareSheet } from "@/components/KeyboardAwareSheet";
import { HazardActionError, useHazardActions } from "@/context/HazardsContext";
import { HAZARD_KINDS, type HazardKind } from "@/lib/hazards/model";
import type { ReportFix } from "@/lib/hazards/report";

const FG = "#F3F5F7";
const MUTED = "rgba(243,245,247,0.65)";
/** How long the confirmation stays before the sheet closes itself */
const DONE_MS = 1600;

type Phase =
  | { step: "choose" }
  | { step: "sending"; kind: HazardKind }
  | { step: "done"; message: string }
  | { step: "failed"; message: string };

export function ReportHazardSheet({
  visible,
  onClose,
  getFix,
}: {
  visible: boolean;
  onClose: () => void;
  /** The latest accepted GPS fix, read when a type is tapped */
  getFix: () => ReportFix | null;
}) {
  const insets = useSafeAreaInsets();
  const { report } = useHazardActions();
  const [phase, setPhase] = useState<Phase>({ step: "choose" });
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (visible) setPhase({ step: "choose" });
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = null;
    };
  }, [visible]);

  const send = async (kind: HazardKind) => {
    if (phase.step === "sending") return;
    Haptics.selectionAsync();
    setPhase({ step: "sending", kind });
    try {
      const message = await report(kind, getFix());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPhase({ step: "done", message });
      closeTimer.current = setTimeout(onClose, DONE_MS);
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPhase({ step: "failed", message: err instanceof HazardActionError ? err.message : "The report wasn't sent." });
    }
  };

  return (
    <KeyboardAwareSheet visible={visible} onClose={onClose} backdropColor="rgba(0,0,0,0.35)">
      <GlassSurface material="dense" style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            Report
          </Text>
          <Text style={styles.subtitle}>At your location now. Anonymous.</Text>
        </View>

        {phase.step === "done" || phase.step === "failed" ? (
          <View style={styles.result} accessibilityLiveRegion="polite">
            <Ionicons
              name={phase.step === "done" ? "checkmark-circle" : "alert-circle"}
              size={40}
              color={phase.step === "done" ? "#34C759" : "#F5B73B"}
            />
            <Text style={styles.resultText}>{phase.message}</Text>
            {phase.step === "failed" ? (
              <GlassButton accessibilityRole="button" style={styles.closeButton} onPress={onClose}>
                <Text style={styles.closeText}>Close</Text>
              </GlassButton>
            ) : null}
          </View>
        ) : (
          <View style={styles.grid}>
            {HAZARD_KINDS.map((k) => {
              const sending = phase.step === "sending" && phase.kind === k.kind;
              return (
                <Pressable
                  key={k.kind}
                  accessibilityRole="button"
                  accessibilityLabel={`Report ${k.label.toLowerCase()}`}
                  accessibilityState={{ disabled: phase.step === "sending", busy: sending }}
                  disabled={phase.step === "sending"}
                  onPress={() => void send(k.kind)}
                  style={({ pressed }) => [styles.tile, pressed && styles.tilePressed, phase.step === "sending" && !sending && styles.tileIdle]}
                >
                  <View style={[styles.badge, { backgroundColor: k.color }]}>
                    {sending ? <ActivityIndicator color="#fff" /> : <Ionicons name={k.icon as keyof typeof Ionicons.glyphMap} size={26} color="#fff" />}
                  </View>
                  <Text style={styles.tileText} numberOfLines={2}>
                    {k.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}

        {phase.step === "choose" ? (
          <GlassButton accessibilityRole="button" style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </GlassButton>
        ) : null}
      </GlassSurface>
    </KeyboardAwareSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 16,
    paddingTop: 18,
    gap: 14,
  },
  header: { alignItems: "center", gap: 2 },
  title: { color: FG, fontSize: 20, fontWeight: "700" },
  subtitle: { color: MUTED, fontSize: 13 },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 10 },
  // Three a row, each a large target (well over 44 pt)
  tile: {
    width: "31.5%",
    minHeight: 104,
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.07)",
  },
  tilePressed: { backgroundColor: "rgba(255,255,255,0.16)" },
  tileIdle: { opacity: 0.45 },
  badge: { width: 50, height: 50, borderRadius: 25, alignItems: "center", justifyContent: "center" },
  tileText: { color: FG, fontSize: 13, fontWeight: "600", textAlign: "center" },
  result: { alignItems: "center", gap: 10, paddingVertical: 18 },
  resultText: { color: FG, fontSize: 16, fontWeight: "600", textAlign: "center", paddingHorizontal: 12 },
  closeButton: { height: 44, paddingHorizontal: 28, borderRadius: 22, alignItems: "center", justifyContent: "center", marginTop: 4 },
  closeText: { color: FG, fontSize: 15, fontWeight: "600" },
  cancel: { height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  cancelText: { color: FG, fontSize: 16, fontWeight: "600" },
});
