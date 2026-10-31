// Local conformance (PLAN §6.2, §6.4, §13): the sync lease and fencing, helper takeover, displace/install, per-agent
// views and status sidecars, the shared-file freeze, and `.cbproj` round trips. Owner: local-cli.
const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function localSuite(opts: { scratchDir: string }): void {
  todo("localSuite");
}
