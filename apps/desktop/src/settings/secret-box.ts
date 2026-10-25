/**
 * PixelForge AI — safeStorage adapter (v3.1 C13; Task 13a).
 *
 * IMPORTANT DISTINCTION (plan review correction C13): Electron `safeStorage`
 * ENCRYPTS secrets with OS-backed keys (DPAPI on Windows, Keychain on macOS,
 * libsecret/kwallet on Linux) — it does NOT store items in the OS keychain.
 * The base64 ciphertext lives in the app's own settings file, which we
 * restrict (0600 on POSIX; DPAPI already binds ciphertext to the Windows
 * user account).
 *
 * This is the only place `electron` is imported for settings; the store and
 * schema stay pure so tests can drive them with a fake SecretBox.
 */

import { safeStorage } from 'electron';

import type { SecretBox } from './store';

export function createSafeStorageBox(): SecretBox {
  // Electron 45 deprecates the sync isEncryptionAvailable() in favor of the
  // async probe; cache ONE probe result at construction (IPC key flows happen
  // long after startup) and fall back to the sync call only if the async API
  // is missing or hasn't resolved yet.
  let cachedAvailability: boolean | null = null;
  const probe = async (): Promise<boolean> => {
    try {
      const anySafe = safeStorage as unknown as { isAsyncEncryptionAvailable?: () => Promise<boolean> };
      if (typeof anySafe.isAsyncEncryptionAvailable === 'function') {
        cachedAvailability = await anySafe.isAsyncEncryptionAvailable();
      } else {
        cachedAvailability = safeStorage.isEncryptionAvailable();
      }
    } catch {
      cachedAvailability = false;
    }
    return cachedAvailability;
  };
  void probe();

  return {
    isAvailable(): boolean {
      if (cachedAvailability !== null) return cachedAvailability;
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },

    backendLabel(): string {
      try {
        switch (process.platform) {
          case 'win32':
            return 'Windows DPAPI';
          case 'darwin':
            return 'macOS Keychain';
          case 'linux':
            return 'libsecret / kwallet';
          default:
            return safeStorage.getSelectedStorageBackend()?.toString() ?? 'OS-provided';
        }
      } catch {
        return 'OS-provided';
      }
    },

    encrypt(plaintext: string): string {
      if (!this.isAvailable()) throw new Error('safeStorage encryption is not available');
      // Buffer → base64 ciphertext for JSON persistence
      return safeStorage.encryptString(plaintext).toString('base64');
    },

    decrypt(ciphertextB64: string): string | null {
      try {
        const buf = Buffer.from(ciphertextB64, 'base64');
        return safeStorage.decryptString(buf);
      } catch {
        // Ciphertext from another user account / machine / backend — treated
        // as a missing key by the store (recovery, not an error).
        return null;
      }
    },
  };
}
