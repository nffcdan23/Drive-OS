// Settings → Help & Support → Diagnostics.
//
// Shows the diagnostics report (lib/backend/diagnosticsReport): app version
// and build, drive state, the orphan journeys the last check reported, and
// the diagnostics journal (lib/diagnostics).  It can be shared with the
// iOS share sheet, or cleared.  It never contains locations, routes or
// sign-in details (see diagnosticsReport for how that's ensured).
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Constants from "expo-constants";
import { GlassSurface, GlassButton } from "@/components/Glass";
import { ScreenTitle } from "@/components/Cockpit";
import { useApp } from "@/context/AppContext";
import { APP_NAME } from "@/constants/brand";
import { journal } from "@/lib/diagnostics";
import { buildDiagnosticsReport } from "@/lib/backend/diagnosticsReport";
import { describeError } from "@/lib/backend/http";
import colors from "@/constants/colors";

const c = colors.dark;

/** The installed binary's own version and build (not the JavaScript bundle's) */
function appInfo() {
  const build =
    Constants.platform?.ios?.buildNumber ??
    Constants.platform?.android?.versionCode?.toString() ??
    Constants.expoConfig?.ios?.buildNumber ??
    null;
  return {
    name: APP_NAME,
    version: Constants.expoConfig?.version ?? null,
    build,
    bundleId: Constants.expoConfig?.ios?.bundleIdentifier ?? null,
    platform: Platform.OS,
    osVersion: String(Platform.Version),
  };
}

export default function DiagnosticsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { diagnosticsState } = useApp();
  const [report, setReport] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const entries = await journal.read();
    setReport(
      buildDiagnosticsReport({
        app: appInfo(),
        generatedAt: new Date(),
        state: diagnosticsState(),
        entries,
      }),
    );
  }, [diagnosticsState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const share = async () => {
    if (!report) return;
    try {
      await Share.share({ message: report, title: `${APP_NAME} diagnostics` });
    } catch (err) {
      Alert.alert("Could not share", describeError(err));
    }
  };

  const clear = () => {
    Alert.alert(
      "Clear diagnostics?",
      "This deletes the diagnostics journal on this phone. Your drives aren't affected.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => {
            void journal.clear().then(refresh);
          },
        },
      ],
    );
  };

  return (
    <View style={s.page}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingHorizontal: 18,
          paddingBottom: insets.bottom + 36,
        }}
      >
        <GlassButton
          style={s.back}
          onPress={() => router.back()}
          accessibilityLabel="Back"
        >
          <Ionicons name="arrow-back" size={23} color={c.foreground} />
        </GlassButton>
        <View style={{ marginTop: 16, marginBottom: 24 }}>
          <ScreenTitle
            title="Diagnostics"
            eyebrow="Drive recording and crash records on this phone."
          />
        </View>
        <GlassSurface style={s.card}>
          <Text style={s.note}>
            A record of drive recording, recovery and crashes, to help us
            investigate problems. It never includes your location, routes or
            sign-in details, and stays on this phone unless you share it.
          </Text>
          <GlassButton
            style={s.action}
            disabled={!report}
            onPress={() => void share()}
          >
            <Ionicons name="share-outline" size={20} color={c.primary} />
            <Text style={s.label}>Share Diagnostics</Text>
          </GlassButton>
          <GlassButton style={s.action} onPress={() => void refresh()}>
            <Ionicons name="refresh" size={20} color={c.primary} />
            <Text style={s.label}>Refresh</Text>
          </GlassButton>
          <GlassButton style={s.action} onPress={clear}>
            <Ionicons name="trash-outline" size={20} color={c.destructive} />
            <Text style={[s.label, { color: c.destructive }]}>
              Clear Diagnostics
            </Text>
          </GlassButton>
        </GlassSurface>
        <GlassSurface style={s.card}>
          {report ? (
            <Text style={s.report} selectable>
              {report}
            </Text>
          ) : (
            <ActivityIndicator color={c.primary} />
          )}
        </GlassSurface>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: c.background },
  back: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  card: { borderRadius: 22, padding: 18, marginBottom: 16, gap: 12 },
  label: { color: c.foreground, fontSize: 15 },
  note: { color: c.mutedForeground, fontSize: 13, lineHeight: 20 },
  action: {
    minHeight: 52,
    borderRadius: 16,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  report: {
    color: c.foreground,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
  },
});
