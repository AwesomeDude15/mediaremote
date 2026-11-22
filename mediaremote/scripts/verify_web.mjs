// Self-verification for the Vercel web app.
// Run from the `web` folder: node ../scripts/verify_web.mjs
// Prints PASS/FAIL lines; exits 1 if anything fails.

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

let failed = false;
const pass = (msg) => console.log(`PASS - ${msg}`);
const fail = (msg) => {
  console.log(`FAIL - ${msg}`);
  failed = true;
};
const run = (cmd, env = {}) =>
  execSync(cmd, { stdio: "pipe", env: { ...process.env, ...env } }).toString();

// 1. package.json has the required dependencies
try {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const required = ["next", "react", "react-dom", "@supabase/supabase-js"];
  const missing = required.filter((dep) => !pkg.dependencies?.[dep]);
  if (missing.length) fail(`package.json missing dependencies: ${missing.join(", ")}`);
  else pass("package.json declares all required dependencies");
} catch (e) {
  fail(`Could not read/parse package.json: ${e.message}`);
}

// 2. Install dependencies
try {
  run("npm install");
  pass("npm install succeeded");
} catch (e) {
  fail(`npm install failed: ${e.stdout?.toString() || e.message}`);
}

// 3. Env file present (at least the example) and the two required keys are referenced in code
if (!existsSync(".env.local.example")) fail(".env.local.example is missing");
else pass(".env.local.example present");

const pageSrc = readFileSync("app/page.js", "utf8");
for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
  if (pageSrc.includes(key)) pass(`page.js references ${key}`);
  else fail(`page.js does not reference ${key}`);
}

// 4. Production build succeeds (uses placeholder env vars so build doesn't fail
//    on missing values — real values are provided at deploy time on Vercel)
try {
  run("npx next build", {
    NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder",
  });
  pass("next build succeeded");
} catch (e) {
  fail(`next build failed: ${e.stdout?.toString() || e.message}`);
}

// 5. Static scan: no accidental secrets committed, no server-only envs leaked wrong way
const envExample = readFileSync(".env.local.example", "utf8");
if (/eyJ[A-Za-z0-9_-]{20,}\./.test(envExample.replace("eyJhbGciOi...", "")))
  fail(".env.local.example appears to contain a real key, not a placeholder");
else pass("No real secrets committed in .env.local.example");

if (failed) {
  console.log("\nOne or more checks FAILED.");
  process.exit(1);
} else {
  console.log("\nAll checks PASSED.");
  process.exit(0);
}
