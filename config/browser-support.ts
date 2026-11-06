// The oldest browsers this app supports (app-business-core issue 721; Matt Murphy
// #296: "test on … the oldest browser"; #323: "a phone from 2019").
//
// MEASURED, NOT ASSUMED. Next.js states Chrome 64 and Safari 12, but the scripts the
// template actually ships use 2020-level JavaScript (optional chaining `?.`, from
// tailwind-merge, which Next.js does not recompile). Measured 2026-11-04 by parsing
// every built script: all parse as ES2020, eight do not parse as ES2017. So the real
// floor is the first browser of each family that runs ES2020, below. A phone from 2019
// on its current system update is well above it (an iPhone 11 runs iOS 13 to 18; a
// Pixel 4 runs a current Chrome).
//
// HELD by scripts/check-browser-floor.ts, run on the built app by the correctness gate
// (CI job `correctness-gate`): any shipped script newer than `ecmaVersion` fails the
// build, so a dependency that starts shipping newer syntax is caught before a user on
// an older phone meets a blank page. Raising the floor is a decision for the CEO: it
// drops the users on the browsers in between.

export const BROWSER_FLOOR = {
  ecmaVersion: 2020,
  browsers: {
    chrome: "80 (February 2020)",
    edge: "80 (February 2020)",
    firefox: "74 (March 2020)",
    safari: "13.1 (March 2020)",
    iosSafari: "13.4 (March 2020)",
    samsungInternet: "13 (December 2020)",
  },
} as const;
