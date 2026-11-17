/** Allow newer V2 hosts; the SDK dependency version is not a host-version pin. */
export function assertHostVersion(version: string): void {
  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (parsed) {
    const [, major, minor, patch, prerelease] = parsed;
    if (major === "2" && (Number(minor) > 2 ||
      Number(minor) === 2 && (Number(patch) > 6 || Number(patch) === 6 && !prerelease))) return;
  }
  throw new Error(`Linklet requires OpenCode >=2.2.6 <3.0.0; this server reports ${version}.`);
}
