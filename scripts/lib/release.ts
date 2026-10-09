/** Release identities are deliberately limited to stable, numeric versions. */
export function releaseVersion(tag: string, version: string): string {
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag) || tag !== tag.trim()) throw new Error("Invalid release tag");
  if (tag !== `v${version}`) throw new Error("Tag does not match package.json version");
  return version;
}

export function releaseNotes(changelog: string, version: string): string {
  releaseVersion(`v${version}`, version);
  const sections = changelog.split(/^## /m);
  const matches = sections.filter(
    (section) => section.split("\n")[0]?.match(/^\[([^\]]+)\](?: - \d{4}-\d{2}-\d{2})?\r?$/)?.[1] === version,
  );
  if (matches.length !== 1) throw new Error(`Expected one CHANGELOG section for ${version}`);
  const notes = matches[0]?.slice(matches[0].indexOf("\n") + 1).trim();
  if (!notes) throw new Error(`Empty CHANGELOG section for ${version}`);
  return `${notes}\n`;
}

export interface CIRun {
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
}

export function requireSuccessfulCI(runs: CIRun[], commit: string): void {
  if (
    !runs.some(
      (run) =>
        run.head_sha === commit &&
        run.head_branch === "main" &&
        run.event === "push" &&
        run.status === "completed" &&
        run.conclusion === "success",
    )
  ) {
    throw new Error("No successful main CI workflow on the tagged commit");
  }
}
