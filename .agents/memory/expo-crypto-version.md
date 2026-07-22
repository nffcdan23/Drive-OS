---
name: expo-crypto version pin
description: expo-crypto must be pinned to ~15.0.9 for Expo SDK 53
---

# expo-crypto version pin

**Rule:** Always install `expo-crypto@~15.0.9` for this project (Expo SDK 53).

**Why:** Installing the package without a version constraint pulls a major version incompatible with SDK 53. Metro resolves the module but Expo warns about peer-version mismatches, and the API surface differs.

**How to apply:** Specify the version on install: `expo-crypto@~15.0.9`. After fixing a version mismatch, clear the Metro cache before restarting.
