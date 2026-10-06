/**
 * Resolver shim so `node --experimental-strip-types` can run the scripts folder.
 *
 * The app source uses the `@/*` path alias from tsconfig, which Next resolves at
 * build time. Node has no tsconfig awareness, so without this hook the first
 * `@/lib/...` import fails before any of our code runs.
 *
 * Kept deliberately tiny: it only rewrites the one alias shape and leaves every
 * other specifier to Node.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(fileURLToPath(new URL("../src", import.meta.url)));
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

/**
 * App source is written extensionless (`./users`), which Next resolves at build
 * time. Node's ESM resolver requires one, so supply it for local paths too.
 */
function withExtension(url) {
  const filePath = fileURLToPath(url);
  if (existsSync(filePath) && path.extname(filePath)) return url;
  for (const extension of EXTENSIONS) {
    const candidate = `${filePath}${extension}`;
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return url;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return nextResolve(
      withExtension(pathToFileURL(path.join(SRC, specifier.slice(2))).href),
      context,
    );
  }

  // Relative specifiers arrive as bare paths, so they have to be turned into
  // absolute URLs against the importing file before the extension can be added.
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("file:")
  ) {
    const base = context.parentURL ?? pathToFileURL(`${process.cwd()}/`).href;
    const absolute = specifier.startsWith("file:")
      ? specifier
      : new URL(specifier, base).href;
    return nextResolve(withExtension(absolute), context);
  }

  return nextResolve(specifier, context);
}