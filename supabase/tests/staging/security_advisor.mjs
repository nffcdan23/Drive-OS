// Fetches the Supabase Security Advisor results for the staging project via
// the Management API and prints them. Fails on any ERROR-level finding.
// Needs SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF (never printed).
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref) {
  console.log('Security Advisor: SKIPPED (SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF not set).');
  console.log('Check it in the dashboard instead: Advisors → Security Advisor.');
  process.exit(0);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/advisors/security`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) {
  console.log(`Security Advisor: could not be fetched (HTTP ${res.status}). Check it in the dashboard: Advisors → Security Advisor.`);
  process.exit(res.status === 401 || res.status === 403 ? 1 : 0);
}

const { lints = [] } = await res.json();
const order = { ERROR: 0, WARN: 1, INFO: 2 };
lints.sort((x, y) => (order[x.level] ?? 3) - (order[y.level] ?? 3));
console.log(`Security Advisor: ${lints.length} finding(s)`);
for (const l of lints) {
  console.log(`  [${l.level}] ${l.name} — ${l.title}`);
  if (l.detail) console.log(`      ${l.detail}`);
}
const errors = lints.filter((l) => l.level === 'ERROR');
if (errors.length) {
  console.log(`Security Advisor: ${errors.length} ERROR-level finding(s) — stopping.`);
  process.exit(1);
}
console.log('Security Advisor: no ERROR-level findings.');
