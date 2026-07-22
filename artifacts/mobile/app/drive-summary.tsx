import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Platform,
  ScrollView, KeyboardAvoidingView, Keyboard,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import * as Haptics from 'expo-haptics';

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Returns the keyboard height on the web by measuring the gap between
 * window.innerHeight and window.visualViewport.height.
 *
 * Works in:
 *  - Mobile Safari (iOS 13+)
 *  - Chrome / Samsung Internet on Android
 *  - Add-to-Home-Screen PWAs (where the viewport does NOT resize the
 *    layout, making this the only reliable signal)
 *
 * Returns 0 in browsers that don't expose visualViewport.
 */
function useWebKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (typeof window === 'undefined') return;

    // `visualViewport` is undefined in very old browsers — guard every access.
    const vv = (window as Window & { visualViewport?: VisualViewport })
      .visualViewport;
    if (!vv) return;

    function measure() {
      // offsetTop is non-zero when the viewport is shifted up (e.g. PWA top bar).
      // The keyboard height is what remains between the full window height and
      // the usable viewport area.
      const kh = Math.max(0, window.innerHeight - vv!.height - vv!.offsetTop);
      setHeight(kh);
    }

    // 'resize' fires as the keyboard slides up/down.
    // 'scroll' fires in PWA mode where the viewport *scrolls* rather than shrinks.
    vv.addEventListener('resize', measure);
    vv.addEventListener('scroll', measure);

    // Capture initial state (e.g. if the page is opened with keyboard already shown)
    measure();

    return () => {
      vv.removeEventListener('resize', measure);
      vv.removeEventListener('scroll', measure);
    };
  }, []);

  return height;
}

export default function DriveSummaryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { currentDrive, endDrive, updateJourney } = useApp();
  const [journeyName, setJourneyName] = useState('');
  const [savedJourneyId, setSavedJourneyId] = useState<string | null>(null);
  const endedRef = useRef(false);

  // Refs for scroll-to-input behaviour
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const nameSectionRef = useRef<View>(null);

  // Web-only: track how many pixels the keyboard is covering
  const webKeyboardHeight = useWebKeyboardHeight();
  const webKeyboardOpen = webKeyboardHeight > 50;

  // End the drive and capture the journey (run once)
  useEffect(() => {
    if (!endedRef.current && currentDrive) {
      endedRef.current = true;
      const j = endDrive();
      if (j) {
        setSavedJourneyId(j.id);
        setJourneyName(j.name);
      }
    }
  }, []);

  // ── Web: scroll input into view whenever the keyboard opens ──────────────
  // We watch `webKeyboardOpen` rather than `webKeyboardHeight` so this only
  // fires on the transition from closed → open (not on every pixel the
  // keyboard travels while sliding up).
  useEffect(() => {
    if (Platform.OS !== 'web' || !webKeyboardOpen) return;

    // Wait for the keyboard animation to finish (~120–350 ms) before
    // calling scrollIntoView so the layout has already shifted.
    const timer = setTimeout(() => {
      // React Native Web renders <TextInput> as a real <input> DOM element;
      // the ref points directly to it on the web bundle.
      const el = inputRef.current as unknown as HTMLElement | null;
      if (el?.scrollIntoView) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [webKeyboardOpen]);

  // ── Native: scroll to the name section when the keyboard appears ─────────
  // We use the Keyboard API so the scroll happens after the keyboard
  // animation, not at focus time (which would be too early to measure).
  useEffect(() => {
    if (Platform.OS === 'web') return;

    const sub = Keyboard.addListener('keyboardDidShow', () => {
      // measureLayout gives the position of nameSectionRef relative to the
      // ScrollView node, so we can scroll the exact amount needed.
      nameSectionRef.current?.measureLayout(
        // getScrollableNode() returns the underlying scroll view node
        scrollRef.current?.getScrollableNode() as Parameters<
          View['measureLayout']
        >[0],
        (_x: number, y: number) => {
          // 24 px gap above the label so the user sees the section heading
          scrollRef.current?.scrollTo({ y: Math.max(0, y - 24), animated: true });
        },
        () => {
          // Fallback: just scroll to the end so buttons remain visible
          scrollRef.current?.scrollToEnd({ animated: true });
        },
      );
    });

    return () => sub.remove();
  }, []);

  const driveDuration = currentDrive?.startTime
    ? Math.round((Date.now() - currentDrive.startTime) / 1000)
    : 0;

  // ── Bottom padding ────────────────────────────────────────────────────────
  // On web we manually pad the scroll content so the action buttons are
  // reachable while the keyboard is open, without resizing the page
  // permanently (height: 100% containers stay untouched).
  // On native, KeyboardAvoidingView shrinks the container instead.
  const scrollBottomPadding =
    Platform.OS === 'web'
      ? Math.max(insets.bottom + 24, webKeyboardHeight + 24)
      : insets.bottom + 24;

  // The gradient hero's top offset
  const heroTopPadding =
    Platform.OS === 'web' ? 67 + insets.top : insets.top + 20;

  const styles = StyleSheet.create({
    // KeyboardAvoidingView must be flex: 1 so it can shrink its children
    kaView: { flex: 1, backgroundColor: colors.background },
    heroGradient: {
      paddingTop: heroTopPadding,
      paddingHorizontal: 24, paddingBottom: 32, alignItems: 'center',
    },
    completedIcon: {
      width: 72, height: 72, borderRadius: 36,
      backgroundColor: 'rgba(255,255,255,0.2)',
      alignItems: 'center', justifyContent: 'center', marginBottom: 16,
    },
    heroTitle: {
      fontSize: 28, fontWeight: '700', color: '#fff', fontFamily: 'Inter_700Bold',
    },
    heroSub: {
      fontSize: 15, color: 'rgba(255,255,255,0.75)',
      fontFamily: 'Inter_400Regular', marginTop: 6,
    },
    statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 24 },
    statCard: {
      flex: 1, minWidth: '45%', backgroundColor: colors.card, borderRadius: 16,
      padding: 16, borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border, alignItems: 'center',
    },
    statValue: {
      fontSize: 24, fontWeight: '700', color: colors.foreground,
      fontFamily: 'Inter_700Bold', marginTop: 8,
    },
    statLabel: {
      fontSize: 12, color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular', marginTop: 4,
    },
    statHighlight: { color: colors.primary },
    nameSection: { marginBottom: 24 },
    nameLabel: {
      fontSize: 14, fontWeight: '600', color: colors.foreground,
      fontFamily: 'Inter_600SemiBold', marginBottom: 10,
    },
    nameInput: {
      backgroundColor: colors.card, borderRadius: 14, padding: 14,
      fontSize: 16, color: colors.foreground, fontFamily: 'Inter_400Regular',
      borderWidth: 2, borderColor: colors.primary,
    },
    actionRow: { gap: 10 },
    viewJourneyBtn: {
      backgroundColor: colors.primary, borderRadius: 14,
      paddingVertical: 15, alignItems: 'center',
    },
    viewJourneyBtnText: {
      fontSize: 16, fontWeight: '600', color: '#fff', fontFamily: 'Inter_600SemiBold',
    },
    backToMapBtn: {
      borderRadius: 14, paddingVertical: 15, alignItems: 'center',
      borderWidth: 1, borderColor: colors.border,
    },
    backToMapBtnText: {
      fontSize: 16, fontWeight: '600', color: colors.foreground,
      fontFamily: 'Inter_600SemiBold',
    },
    demoNote: {
      backgroundColor: colors.muted, borderRadius: 10, padding: 10, marginTop: 16,
    },
    demoNoteText: {
      fontSize: 11, color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular', textAlign: 'center',
    },
  });

  function handleSaveAndView() {
    if (savedJourneyId && journeyName.trim()) {
      updateJourney(savedJourneyId, { name: journeyName.trim() });
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.replace('/(tabs)/journeys');
  }

  function handleBackToMap() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.replace('/(tabs)');
  }

  return (
    /**
     * KeyboardAvoidingView handles native iOS (and Android if needed).
     * On web it renders as a plain View — no layout side-effects — so the
     * visualViewport hook takes over for the web path.
     *
     * keyboardVerticalOffset = 0 because this screen has no navigation bar
     * above it (the gradient is the custom header).
     */
    <KeyboardAvoidingView
      style={styles.kaView}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Fixed gradient hero — sits outside the ScrollView so it never scrolls away */}
      <LinearGradient colors={['#F4631A', '#FF4E3A']} style={styles.heroGradient}>
        <View style={styles.completedIcon}>
          <Ionicons name="checkmark" size={36} color="#fff" />
        </View>
        <Text style={styles.heroTitle}>Drive Complete</Text>
        <Text style={styles.heroSub}>Great drive! Here's your summary.</Text>
      </LinearGradient>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ padding: 24, paddingBottom: scrollBottomPadding }}
        showsVerticalScrollIndicator={false}
        // Allow taps on buttons inside while the keyboard is up
        keyboardShouldPersistTaps="handled"
        // On iOS, don't shrink the ScrollView — KeyboardAvoidingView does that
        keyboardDismissMode="interactive"
      >
        {/* Stats grid */}
        <View style={styles.statsGrid}>
          <View style={styles.statCard}>
            <Ionicons name="navigate-outline" size={24} color={colors.primary} />
            <Text style={styles.statValue}>
              {currentDrive ? currentDrive.estimatedDistance.toFixed(1) : '0.0'} km
            </Text>
            <Text style={styles.statLabel}>Distance</Text>
          </View>
          <View style={styles.statCard}>
            <Ionicons name="time-outline" size={24} color={colors.primary} />
            <Text style={styles.statValue}>{formatDuration(driveDuration)}</Text>
            <Text style={styles.statLabel}>Duration</Text>
          </View>
          <View style={styles.statCard}>
            <Ionicons name="speedometer-outline" size={24} color={colors.primary} />
            <Text style={[styles.statValue, styles.statHighlight]}>
              {currentDrive ? Math.round(currentDrive.topSpeed) : 0} km/h
            </Text>
            <Text style={styles.statLabel}>Top Speed</Text>
          </View>
          <View style={styles.statCard}>
            <Ionicons name="car-outline" size={24} color={colors.primary} />
            <Text style={styles.statValue}>
              {currentDrive && currentDrive.speedSamples.length > 0
                ? Math.round(
                    currentDrive.speedSamples.reduce((a, b) => a + b, 0) /
                      currentDrive.speedSamples.length,
                  )
                : 0}{' '}
              km/h
            </Text>
            <Text style={styles.statLabel}>Avg Speed</Text>
          </View>
        </View>

        {/* Journey name input — this is the element that must stay visible */}
        <View ref={nameSectionRef} style={styles.nameSection}>
          <Text style={styles.nameLabel}>Name this journey</Text>
          <TextInput
            ref={inputRef}
            style={styles.nameInput}
            value={journeyName}
            onChangeText={setJourneyName}
            placeholder="e.g. Lake District Loop"
            placeholderTextColor={colors.mutedForeground}
            returnKeyType="done"
            // Dismiss the keyboard on "Done" without clearing the value
            onSubmitEditing={() => Keyboard.dismiss()}
            blurOnSubmit
          />
        </View>

        {/* Action buttons */}
        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.viewJourneyBtn} onPress={handleSaveAndView}>
            <Text style={styles.viewJourneyBtnText}>Save &amp; View Journey</Text>
          </TouchableOpacity>
          <View style={{ height: 10 }} />
          <TouchableOpacity style={styles.backToMapBtn} onPress={handleBackToMap}>
            <Text style={styles.backToMapBtnText}>Back to Map</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.demoNote}>
          <Text style={styles.demoNoteText}>
            Demo mode: distance &amp; speed tracked where browser location was granted.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
