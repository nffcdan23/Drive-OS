// App entry.  The background drive-recording task must be defined before
// anything else runs: when the system relaunches the app in the background to
// deliver locations, no screens (and so no route files) are loaded.
import './lib/driveBackgroundLocation';
import 'expo-router/entry';
