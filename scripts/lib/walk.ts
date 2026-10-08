// Lists the files in a build folder for verification and the manifest.
// Only regular files and directories are allowed: a symbolic link or any other
// entry type (FIFO, socket, device) is an error, never skipped, so nothing in
// the folder can escape the checks or the manifest.

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export class UnsafeEntryError extends Error {}

/** Relative paths (with "/") of every regular file under `root`, sorted. */
export async function listRegularFiles(root: string): Promise<string[]> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new UnsafeEntryError(`${root} is not a plain directory`);

  const files: string[] = [];
  const problems: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      // lstat, not the dirent, so the answer never depends on following a link.
      const info = await lstat(join(dir, entry.name));
      if (info.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (info.isFile()) files.push(rel);
      else problems.push(`${rel}: ${info.isSymbolicLink() ? "symbolic link" : "not a regular file"}`);
    }
  }
  await walk(root, "");
  if (problems.length > 0) throw new UnsafeEntryError(problems.join("\n"));
  return files.sort();
}
