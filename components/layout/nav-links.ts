// Primary navigation links shown in the app shell's sidebar and mobile nav.
// Kept as a plain data module (no JSX) so it can be tested directly without a
// React-rendering toolchain -- see nav-links.test.ts.
export const primaryNavLinks = [
  ["Today", "/today"],
  ["Parlay Builder", "/slip-analyzer"],
  ["My Picks", "/my-picks"],
  ["Performance", "/performance"],
] as const;
