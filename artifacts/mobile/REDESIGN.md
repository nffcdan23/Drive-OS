# Cockpit redesign evaluation

Branch: `ui/astra-redesign-v2`.
Original: `main` at `a775dfcd09eccc97c759edaf415daa3c6666175c`.

## Run

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @workspace/mobile exec expo start --clear
```

Open the QR code in an Expo client compatible with this repository's SDK 57,
or use the existing development build. Native maps and GPS require a device.
For the illustrative browser preview, add `--web`.

## Evaluate

- Map: destination search; bookmark control for saved/recent shortcuts; vehicle
  disclosure; map layers, heading, follow and friends controls; start drive.
- Drive: speed/distance/time, expandable average/top speed, pause/resume,
  save point, follow/zoom and end-drive confirmation. Verify these while stationary.
- Journeys: actual recorded route silhouettes, period/category/type filters,
  sorting, expandable statistics and category management.
- Garage: image-led cards, active vehicle selection, add/edit/remove.
- Community: convoy overview, friends/groups/events and creation forms.
- Profile: driver identity, progression, achievements and settings.

## Implementation

`constants/colors.ts` supplies the graphite/amber palette and reusable tokens.
`components/Cockpit.tsx` supplies titles and disclosure. `RouteTrace.tsx` draws
bounded, sampled route geometry from existing coordinates. Core tab screens,
the tab navigator and `ActiveDriveOverlay.tsx` implement the presentation.
The navigator uses a consistent cross-platform bar that hides during recording.
The default appearance is intentionally dark, including native system surfaces.

No application dependencies added. No API, storage, schema or authentication
changes. Existing handlers retained. Existing unimplemented profile shortcuts,
OBD, live routing/ETA and convoy map positioning are not newly implemented.
The app currently wires the HUD in tracking mode; the manoeuvre card is styled
but a navigation provider is still required. No invented route progress is shown.

## Validation and limitations

- Mobile TypeScript check passes. `tsconfig.typecheck.json` maps React types for
  isolated pnpm packages without redirecting Metro's runtime React import.
- iOS and Android production JavaScript/Hermes bundles export successfully.
- Browser review covers all five tabs at 390x844 and compact map/journey layouts
  at 320x700, including destination/vehicle disclosure and expanded statistics.
- Web map stub now supports the AnimatedRegion object used by location code.
- Physical-device GPS, notches, large accessibility text and native keyboard
  interactions still require on-device acceptance testing.
- This workspace excludes Windows Lightning CSS binaries. Local preview QA used
  the matching optional `lightningcss-win32-x64-msvc@1.32.0` package in the system
  temporary directory, linked into ignored node_modules. Manifests/lockfile were
  not changed for this repair; reinstalling dependencies may require repeating it.

## Return to the original

Stop Expo, run `git switch main`, then restart Expo with `--clear`.
To return to this version, run `git switch ui/astra-redesign-v2`.
No merge or push has been performed. Switching branches does not reset app data.

## Glass refinement

`components/Glass.tsx` supplies shared chrome, dense and amber action materials.
Compatible iOS builds use Expo's native glass; older iOS uses the existing blur
package. Android deliberately uses a solid graphite fallback to avoid repeated
live blur over the map. Web uses CSS backdrop blur through Expo.

The map search, floating controls, vehicle sheet, tab dock, drive HUD, search
input and journey/community modal sheets share the material. List content and
vehicle imagery remain opaque. Press feedback uses a small native-driver spring;
Reduce Motion disables it. iOS Reduce Transparency selects solid surfaces and
removes the sheen. HUD and form sheets use denser scrims for legibility.

No dependencies added. Check the native material on an iPhone, including Reduce
Transparency and Reduce Motion, and verify foreground text against bright and
dark map tiles. Browser preview validates layout, not Apple's native glass.
