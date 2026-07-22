import React, { useState, useRef } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, Platform,
  TextInput, KeyboardAvoidingView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import * as Haptics from 'expo-haptics';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { conversations, messages, sendMessage, markConversationRead } = useApp();
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList>(null);

  const conv = conversations.find((c) => c.id === id);
  const convMessages = messages.filter((m) => m.conversationId === id);

  React.useEffect(() => {
    if (id) markConversationRead(id);
  }, [id]);

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingTop: Platform.OS === 'web' ? 67 + insets.top : insets.top,
      paddingHorizontal: 16, paddingBottom: 12,
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    backBtn: { padding: 4 },
    avatar: {
      width: 36, height: 36, borderRadius: 18,
      backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center',
    },
    avatarText: { fontSize: 13, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    headerName: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.foreground, fontFamily: 'Inter_600SemiBold' },
    list: { flex: 1 },
    listContent: { padding: 16, paddingBottom: 8 },
    // Bubbles
    bubbleRow: { flexDirection: 'row', marginBottom: 10 },
    bubbleRowOwn: { justifyContent: 'flex-end' },
    bubble: {
      maxWidth: '75%', paddingHorizontal: 14, paddingVertical: 10,
      borderRadius: 18, backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    bubbleOwn: {
      backgroundColor: colors.primary, borderWidth: 0,
    },
    bubbleText: { fontSize: 15, color: colors.foreground, fontFamily: 'Inter_400Regular', lineHeight: 21 },
    bubbleTextOwn: { color: '#fff' },
    bubbleTime: { fontSize: 11, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 4 },
    bubbleTimeOwn: { color: 'rgba(255,255,255,0.65)', textAlign: 'right' },
    // Input bar
    inputBar: {
      flexDirection: 'row', alignItems: 'flex-end', gap: 10,
      paddingHorizontal: 16, paddingTop: 10,
      paddingBottom: Math.max(insets.bottom, 12),
      backgroundColor: colors.background,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
    },
    input: {
      flex: 1, backgroundColor: colors.card, borderRadius: 22, paddingHorizontal: 16,
      paddingVertical: 10, fontSize: 15, color: colors.foreground,
      fontFamily: 'Inter_400Regular', maxHeight: 120,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    sendBtn: {
      width: 42, height: 42, borderRadius: 21,
      backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    },
    sendBtnDisabled: { backgroundColor: colors.muted },
    emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    emptyText: { fontSize: 14, color: colors.mutedForeground, fontFamily: 'Inter_400Regular', marginTop: 8 },
  });

  if (!conv) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: colors.foreground }}>Conversation not found</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 12 }}>
          <Text style={{ color: colors.primary, fontFamily: 'Inter_500Medium' }}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  function handleSend() {
    if (!draft.trim()) return;
    sendMessage(id!, draft.trim());
    setDraft('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <View style={styles.avatar}><Text style={styles.avatarText}>{conv.participantInitials}</Text></View>
        <Text style={styles.headerName}>{conv.participantName}</Text>
      </View>

      <FlatList
        ref={listRef}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={convMessages}
        keyExtractor={(item) => item.id}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="chatbubble-outline" size={40} color={colors.mutedForeground} />
            <Text style={styles.emptyText}>Start the conversation</Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={[styles.bubbleRow, item.isOwn && styles.bubbleRowOwn]}>
            <View style={[styles.bubble, item.isOwn && styles.bubbleOwn]}>
              <Text style={[styles.bubbleText, item.isOwn && styles.bubbleTextOwn]}>{item.content}</Text>
              <Text style={[styles.bubbleTime, item.isOwn && styles.bubbleTimeOwn]}>{formatTime(item.createdAt)}</Text>
            </View>
          </View>
        )}
      />

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={`Message ${conv.participantName}…`}
          placeholderTextColor={colors.mutedForeground}
          multiline
          returnKeyType="send"
          onSubmitEditing={Platform.OS !== 'ios' ? handleSend : undefined}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          style={[styles.sendBtn, !draft.trim() && styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!draft.trim()}
        >
          <Ionicons name="send" size={18} color={draft.trim() ? '#fff' : colors.mutedForeground} />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}
