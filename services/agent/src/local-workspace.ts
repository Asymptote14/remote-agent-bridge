import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const FILE_LIMIT_BYTES = 16 * 1024;
const DIRECTORY_LIMIT = 100;
const DIRECTORY_SCAN_LIMIT = 500;
const TRUNCATED = '\n…（内容已截断）';

function inside(root: string, target: string) {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function privateName(name: string) {
  return name.startsWith('.') || /[.\s]$|[\x00-\x1f:]/u.test(name) ||
    /^(node_modules|providers\.json|agent-identity\.json|setup-token|credentials(?:\..*)?|id_(?:rsa|ed25519|ecdsa))$/i.test(name) ||
    /\.(?:key|pem|pfx|p12|ppk|kdbx)$/i.test(name) ||
    /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name);
}

const samePath = (left: string, right: string) => relative(left, right) === '';

export class LocalWorkspace {
  private root?: Promise<string>;

  constructor(private readonly configuredRoot: string, private readonly protectedPaths: () => string[] = () => []) {}

  private async guard(candidate: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const parts = candidate.split(/[/\\]/).filter(part => part && part !== '.');
    if (/^[/\\]/.test(candidate) || parts.some(part => part === '..')) throw new Error('path_outside_workspace');
    if (parts.some(privateName)) throw new Error('path_not_allowed');

    this.root ??= realpath(resolve(this.configuredRoot));
    const root = await this.root;
    const protectedPaths = (await Promise.all(this.protectedPaths().map(async path => {
      const absolute = resolve(path);
      try { return [absolute, await realpath(absolute)]; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return [absolute];
      }
    }))).flat();
    const permitted = (target: string) => inside(root, target) && !protectedPaths.some(path => inside(path, target));
    if (!permitted(root) || !samePath(root, await realpath(root))) throw new Error('path_not_allowed');

    let target = root;
    for (const part of parts) {
      signal?.throwIfAborted();
      target = join(target, part);
      if (!permitted(target)) throw new Error('path_not_allowed');
      if ((await lstat(target)).isSymbolicLink() || !samePath(target, await realpath(target))) throw new Error('path_link_not_allowed');
    }
    return { target, permitted };
  }

  private async withSafePath<T>(operation: () => Promise<T>) {
    try { return await operation(); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error('path_not_found');
      if (code === 'ELOOP') throw new Error('path_link_not_allowed');
      if (code === 'EISDIR') throw new Error('not_a_regular_file');
      if (code === 'EACCES' || code === 'EPERM') throw new Error('path_access_denied');
      if (code && code !== 'ABORT_ERR') throw new Error('path_unavailable');
      throw error;
    }
  }

  readText(candidate: string, signal?: AbortSignal) {
    return this.withSafePath(async () => {
      const { target } = await this.guard(candidate, signal);
      const expected = await lstat(target, { bigint: true });
      if (!expected.isFile() || expected.nlink !== 1n) throw new Error('not_a_regular_file');
      const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const handle = await open(target, flags);
      try {
        const opened = await handle.stat({ bigint: true });
        const current = await lstat((await this.guard(candidate, signal)).target, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || !current.isFile() || current.nlink !== 1n ||
            opened.dev !== expected.dev || opened.ino !== expected.ino || opened.dev !== current.dev || opened.ino !== current.ino) {
          throw new Error('path_changed');
        }

        const buffer = Buffer.alloc(FILE_LIMIT_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
          signal?.throwIfAborted();
          const result = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        signal?.throwIfAborted();
        const truncated = offset > FILE_LIMIT_BYTES;
        const bytes = buffer.subarray(0, Math.min(offset, FILE_LIMIT_BYTES));
        if (bytes.includes(0)) throw new Error('text_file_required');
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated }); }
        catch { throw new Error('text_file_required'); }
        return (content || '文件为空') + (truncated ? TRUNCATED : '');
      } finally {
        await handle.close();
      }
    });
  }

  list(candidate: string, signal?: AbortSignal) {
    return this.withSafePath(async () => {
      const { target, permitted } = await this.guard(candidate, signal);
      const directory = await opendir(target);
      try {
        await this.guard(candidate, signal);
        const names: string[] = [];
        for (let scanned = 0; scanned < DIRECTORY_SCAN_LIMIT; scanned += 1) {
          signal?.throwIfAborted();
          const entry = await directory.read();
          if (!entry) return names.join('\n') || '目录为空或没有可显示的文件';
          if (!entry.isDirectory() && !entry.isFile()) continue;
          if (!privateName(entry.name) && permitted(join(target, entry.name))) {
            if (names.length === DIRECTORY_LIMIT) break;
            names.push(`${entry.isDirectory() ? '[目录]' : '[文件]'} ${entry.name}`);
          }
        }
        return names.join('\n') + TRUNCATED;
      } finally {
        await directory.close();
      }
    });
  }
}
