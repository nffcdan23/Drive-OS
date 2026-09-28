// Lets `node --test` run the app's TypeScript modules directly (Node 22 type
// stripping) by resolving the `@/` alias and extensionless imports the way
// Metro does. Test-only; not part of the app bundle.
import { register } from 'node:module';
register('./resolve-hook.mjs', import.meta.url);
