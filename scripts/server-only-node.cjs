// Lets Node-run TOOLING load server modules marked `import "server-only"`.
//
// Every lib/ file that touches the database, a key or a credential starts with
// `import "server-only"` (app-business-core issue 797, Matt Murphy #54). The
// package resolves to an empty module under the "react-server" condition, which
// Next.js uses for server code, and to a module that THROWS everywhere else —
// so a client component that reaches one of those files fails the build.
//
// Plain Node has no "react-server" condition, so the template's own tooling —
// the tsx scripts (`npx tsx scripts/migrate.ts`, run by the shared deploy
// workflow) and the Playwright specs that seed databases — would hit the
// throwing module. Each of them requires THIS file first: it puts the empty
// module in Node's require cache under the package's resolved path, so the
// marker is a no-op for that one process.
//
// Only tooling may require it. tests/unit/server-boundary.test.ts fails if any
// file under app/, components/, lib/ or config/ names it — the app itself can
// never switch the marker off. Vitest gets the same effect from an alias in
// vitest.config.ts.

"use strict";

// A CommonJS file by design: it must run before the ESM-free tooling loads lib/.
/* eslint-disable @typescript-eslint/no-require-imports */

const Module = require("node:module");

const resolved = require.resolve("server-only");
if (!require.cache[resolved]) {
  const stub = new Module(resolved);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = {};
  require.cache[resolved] = stub;
}
