// App entry.  The diagnostics journal comes first: it notes the launch and
// records a fatal JavaScript error from anything after it.  Then the
// background drive-recording task, which must be defined before anything
// else runs: when the system relaunches the app in the background to
// deliver locations, no screens (and so no route files) are loaded.
import './lib/diagnostics';
import './lib/driveBackgroundLocation';
import 'expo-router/entry';
