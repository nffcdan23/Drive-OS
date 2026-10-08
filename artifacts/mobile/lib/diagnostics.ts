/**
 * The app's diagnostics journal (lib/backend/journal), wired up.
 *
 * Imported first by the entry file (index.js), so it is in place however the
 * app was started, including when iOS launches it in the background to
 * deliver locations.  On import it:
 *
 *  - notes the launch, and whether it was in the foreground or background;
 *  - moves the last fatal JavaScript error (saved as the app died, below)
 *    into the journal;
 *  - wraps the global JavaScript error handler so a fatal error is saved
 *    before React Native ends the app.  That save is synchronous (the
 *    keychain, through expo-secure-store), because nothing asynchronous runs
 *    after a fatal error.
 *
 * Kept on the device; Settings can share it later (journal.text()).
 */
import { AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { DiagnosticsJournal, fatalErrorRecord } from '@/lib/backend/journal';
import { deviceStorage } from '@/lib/secureStorage';

export const journal = new DiagnosticsJournal({ store: deviceStorage });

const LAST_FATAL_KEY = 'derwent.diagnostics.lastFatalJsError';
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

type ErrorHandler = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsLike { getGlobalHandler(): ErrorHandler; setGlobalHandler(handler: ErrorHandler): void }

function collectLastFatal() {
  try {
    const raw = SecureStore.getItem(LAST_FATAL_KEY, KEYCHAIN);
    if (!raw) return;
    journal.log('fatal_js_error', JSON.parse(raw) as Record<string, string>);
    void SecureStore.deleteItemAsync(LAST_FATAL_KEY, KEYCHAIN).catch(() => {});
  } catch {
    // Unreadable (or the keychain is locked): left for the next launch.
  }
}

function recordFatalErrors() {
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (!errorUtils) return;
  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    if (isFatal) {
      try {
        SecureStore.setItem(LAST_FATAL_KEY, JSON.stringify(fatalErrorRecord(error, Date.now(), AppState.currentState)), KEYCHAIN);
      } catch {
        // Nothing more can be done as the app ends.
      }
    }
    previous(error, isFatal);
  });
}

journal.log('launch', { appState: AppState.currentState ?? 'unknown', platform: Platform.OS });
if (Platform.OS !== 'web') {
  collectLastFatal();
  recordFatalErrors();
}
