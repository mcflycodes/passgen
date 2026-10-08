// A plain static file server for tests and local checks (decision 0005).
// It serves a folder with node:http only, applies the reference headers from
// security/headers.ts to every response (including 404s), and can mount the
// folder under a subpath to prove the build works away from the domain root.
//
// It serves regular files only. Symbolic links anywhere below the root, including
// a directory's index.html, are refused, and the file finally opened must be the
// one that was checked and must sit inside the root's canonical path.
//
// Scope: this is a development and test tool, not a deployment target. It, and
// the build-folder walker used by verify-dist and the manifest, assume the tree
// being served is not changed while they run. Swapping files, directories or
// symlinks underneath them from another local process is out of scope.

import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { SECURITY_HEADERS } from "../../security/headers.ts";

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
};

export interface StaticServerOptions {
  /** Folder to serve. */
  readonly root: string;
  /** URL path the folder is mounted at, e.g. "/" or "/tools/passgen/". */
  readonly base?: string;
  /** Apply the reference security headers. False simulates a host that cannot set headers. */
  readonly headers?: boolean;
}

/** A request the server answers with 404 without saying why. */
class NotFound extends Error {}

const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

export function createStaticServer(options: StaticServerOptions): Server {
  const base = normalizeBase(options.base ?? "/");
  const withHeaders = options.headers ?? true;

  return createServer(async (req, res) => {
    if (withHeaders) {
      for (const h of SECURITY_HEADERS) res.setHeader(h.name, h.value);
    }
    res.setHeader("Cache-Control", "no-store");

    const send = (status: number, body: string) => {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : body);
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return send(405, "Method not allowed\n");
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://placeholder.invalid").pathname);
    } catch {
      return send(400, "Bad request\n");
    }
    if (pathname.includes("\0")) return send(400, "Bad request\n");

    if (`${pathname}/` === base) {
      res.writeHead(301, { Location: base });
      return res.end();
    }
    if (!pathname.startsWith(base)) return send(404, "Not found\n");

    let handle: FileHandle | undefined;
    try {
      const opened = await openContained(options.root, pathname.slice(base.length));
      handle = opened.handle;
      res.writeHead(200, {
        "Content-Type": MIME[extname(opened.path)] ?? "application/octet-stream",
        "Content-Length": opened.size,
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      const stream = handle.createReadStream();
      handle = undefined; // the stream owns the handle now and closes it
      await pipeline(stream, res);
    } catch (err) {
      failResponse(res, send, err);
    } finally {
      await handle?.close().catch(() => {});
    }
  });
}

/**
 * Opens the regular file a URL path names, refusing anything that is not
 * plainly inside the root: ".." segments, symbolic links at any level, and
 * anything that is not a regular file once a directory's index.html is applied.
 */
async function openContained(
  rootOption: string,
  relativePath: string,
): Promise<{ handle: FileHandle; path: string; size: number }> {
  const root = await realpath(rootOption);
  const segments = relativePath.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) throw new NotFound();

  let path = root;
  let info = await lstat(path);
  for (const segment of segments) {
    if (!info.isDirectory()) throw new NotFound();
    path = join(path, segment);
    info = await lstat(path);
    if (info.isSymbolicLink()) throw new NotFound();
  }
  if (info.isDirectory()) {
    path = join(path, "index.html");
    info = await lstat(path);
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new NotFound();

  const canonical = await realpath(path);
  if (!canonical.startsWith(root + sep)) throw new NotFound();

  // O_NOFOLLOW refuses a symlink swapped in after the checks; the inode check
  // refuses any other file swapped in.
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw new NotFound();
    return { handle, path: canonical, size: opened.size };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

function failResponse(res: ServerResponse, send: (status: number, body: string) => void, err: unknown): void {
  if (res.headersSent) {
    // The status line is gone; cut the connection so the client sees a truncated body, not a short file.
    res.destroy();
    return;
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (err instanceof NotFound || (code !== undefined && NOT_FOUND_CODES.has(code))) send(404, "Not found\n");
  else send(500, "Internal server error\n");
}

function normalizeBase(base: string): string {
  let b = base.startsWith("/") ? base : `/${base}`;
  if (!b.endsWith("/")) b += "/";
  return b;
}
