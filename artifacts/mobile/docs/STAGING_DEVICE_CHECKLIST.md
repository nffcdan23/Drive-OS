# Real-device staging test checklist

Use this for the first test on a physical iPhone (and optionally an Android phone) against **staging**. Nothing here touches production.

## Before you start
- [ ] **Staging API is hosted** on HTTPS with the variables in `ENVIRONMENT.md` §3. `https://<api>/api/readyz` returns `{"status":"ok","database":"ok"}`.
- [ ] **Supabase staging settings:** "Confirm email" is off, and the redirect URLs are added (`ENVIRONMENT.md` §5).
- [ ] **Choose how to install. Both routes avoid registering a final bundle id:**
  - **Option A: Expo Go** (no build, no bundle id).
    - Run `npx expo start` with `artifacts/mobile/.env` pointing at staging.
    - Add `exp://<your-LAN-IP>:8081/--/auth/callback` to the Supabase redirect URLs.
    - Sign in with Apple can't be tested in Expo Go against your own App ID. Email and Google can.
  - **Option B: an internal EAS build** with a **temporary, clearly throwaway** `APP_BUNDLE_ID`.
    - Example: `com.<yourname>.devtest`, **not** a name you might ship under.
    - This registers that throwaway id with Apple; you can delete it later.
    - Use `staging-simulator` for an iOS Simulator build, which needs no Apple registration at all.

## Accounts
1. [ ] Fresh install → the sign-in screen shows the **STAGING SERVER** badge.
2. [ ] **Create an account with email and password.** You land in the app, and Profile shows your name.
3. [ ] Invalid email or short password → a clear message, and no crash.
4. [ ] **Sign out** (Settings → Account) → back to sign-in.
5. [ ] **Sign in again** with the same details. A wrong password shows a message.
6. [ ] **Force-quit and reopen** → still signed in, with no sign-in screen.
7. [ ] Leave the app for over 1 hour (the access token expires), reopen → still signed in and data loads, because the session refreshed.
8. [ ] **Forgot password** → the email link opens the app → set a new password → sign in with it. This needs working email, so skip it on staging if Confirm email/SMTP is off.
9. [ ] **Google** (once configured) → the account picker → back in the app, signed in.
10. [ ] **Apple** (once the Apple setup is done, Option B only) → Face ID sheet → signed in. Your name appears the first time.

## Your data
11. [ ] **Profile:** edit name and bio → force-quit → the edits remain.
12. [ ] **Avatar:** tap the avatar → pick a photo → it appears, and it remains after a restart.
13. [ ] **Garage:** add a vehicle → force-quit → the vehicle remains. Add a second one and make it active.
14. [ ] **Vehicle photo:** add a photo to a vehicle → it shows, and still shows after a restart. Try a large, 12 MP photo.
15. [ ] **Places:** Map → Home → "Save where I am" as Home. It's listed as private.
16. [ ] **Beauty Spot:** save one as "Everyone" → it's listed under My Beauty Spots.
17. [ ] **Record a journey:** Start Drive → drive or walk for 5+ minutes with the screen **on** → End.
    - The summary shows the drive.
    - The journey appears with a route.
    - XP increases.
18. [ ] Force-quit → the journey's **route still displays** in Journeys and on the journey's detail screen.

## Second person and second device
19. [ ] On a second phone (or after signing out), create **account B**.
    - B's garage, journeys and places are empty.
    - B can see A's public Beauty Spot under Places → Beauty Spots → Shared nearby, when near it.
20. [ ] Sign in to **account A on the second phone** → the same vehicles, photos, journeys, places and profile appear.

## Failures must be visible
21. [ ] **Airplane mode:** add a vehicle → the banner says "Offline — 1 change saved on this phone"; the vehicle shows "waiting".
    - Turn airplane mode off → within about 30 s the banner clears and the vehicle exists on the second phone.
22. [ ] **Airplane mode during a drive:** start a drive, go offline, drive, end the drive → the journey shows "Waiting to upload".
    - Go back online → it uploads, and the route and XP appear.
23. [ ] **Stop the staging API** (or point at a wrong URL) → the banner reports a server problem, and cached data is still shown.

## Account deletion
24. [ ] Settings → Delete account → type DELETE → you're returned to sign-in.
    - Signing in with that account fails.
    - On the second phone, that account's data is gone after refresh.

## Record for each run
- **Device:** model and OS version.
- **Build:** build number or commit, and whether it was Expo Go or an EAS build.
- **Results:** pass or fail per item, with screenshots of any failures.
