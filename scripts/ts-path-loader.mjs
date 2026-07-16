import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const rootDir = process.cwd();
const extensions = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'];

async function existsAsFile(candidatePath) {
  try {
    const result = await stat(candidatePath);
    return result.isFile();
  } catch {
    return false;
  }
}

async function findExistingPath(basePath) {
  if (await existsAsFile(basePath)) return basePath;
  for (const suffix of extensions) {
    const candidatePath = `${basePath}${suffix}`;
    if (await existsAsFile(candidatePath)) return candidatePath;
  }
  return null;
}

async function resolveProjectAlias(specifier) {
  const relativePath = specifier.slice(2);
  const resolvedPath = await findExistingPath(path.join(rootDir, relativePath));
  return resolvedPath ? pathToFileURL(resolvedPath).href : null;
}

async function resolveRelativeSpecifier(specifier, parentURL) {
  if (!parentURL?.startsWith('file://')) return null;
  const parentPath = fileURLToPath(parentURL);
  const parentDir = path.dirname(parentPath);
  const resolvedPath = await findExistingPath(path.resolve(parentDir, specifier));
  return resolvedPath ? pathToFileURL(resolvedPath).href : null;
}

export async function resolve(specifier, context, defaultResolve) {
  if (specifier.startsWith('@/')) {
    const resolved = await resolveProjectAlias(specifier);
    if (!resolved) {
      throw new Error(`Unable to resolve alias ${specifier} from ${context.parentURL ?? '<root>'}`);
    }
    return { url: resolved, shortCircuit: true };
  }

  try {
    return await defaultResolve(specifier, context, defaultResolve);
  } catch (error) {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const resolved = await resolveRelativeSpecifier(specifier, context.parentURL);
      if (resolved) return { url: resolved, shortCircuit: true };
    }
    throw error;
  }
}
