import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Locates locally installed agent CLIs so the setup page can offer them.
 *
 * These are pure filesystem probes: they never launch anything, so a missing or
 * broken installation simply yields no candidate.
 */

export function workBuddyCandidates() {
  const roots = [
    process.env.WORKBUDDY_HOME,
    'C:\\workbuddy',
    'D:\\workbuddy',
    'E:\\workbuddy',
    'F:\\workbuddy',
    'G:\\workbuddy',
    join(process.env.LOCALAPPDATA || '', 'WorkBuddy'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy'),
    join(process.env.ProgramFiles || '', 'WorkBuddy'),
  ].filter(Boolean) as string[];
  const result: Array<{ installPath: string; executable: string; runtime: string; version?: string }> = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const installPath = root.replace(/[\\/]$/, '');
    const workbuddyExe = join(installPath, 'WorkBuddy.exe');
    const cli = join(installPath, 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy');
    if (!existsSync(cli) || seen.has(cli.toLowerCase())) continue;
    seen.add(cli.toLowerCase());
    const versionPath = join(installPath, 'resources', 'app.asar.unpacked', 'cli', 'package.json');
    let version: string | undefined;
    try {
      const pkg = JSON.parse(readFileSync(versionPath, 'utf8')) as { publishConfig?: { customPackage?: { version?: string } }; version?: string };
      version = pkg.publishConfig?.customPackage?.version || pkg.version;
    } catch { /* Version is optional. */ }
    result.push({ installPath, executable: existsSync(workbuddyExe) ? workbuddyExe : cli, runtime: process.execPath, version });
  }
  return result;
}

export function codexCandidates() {
  const configured = process.env.CODEX_CLI_PATH;
  const fixedCandidates = [
    configured,
    join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    'C:\\Program Files\\OpenAI\\Codex\\codex.exe',
  ].filter(Boolean) as string[];
  const versionedCandidates: string[] = [];
  const codexBin = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  try {
    for (const entry of readdirSync(codexBin, { withFileTypes: true })) {
      if (entry.isDirectory()) versionedCandidates.push(join(codexBin, entry.name, 'codex.exe'));
    }
  } catch { /* The installation directory may not exist. */ }
  const candidates = [...fixedCandidates, ...versionedCandidates];
  const seen = new Set<string>();
  return candidates.filter(executable => {
    const key = executable.toLowerCase();
    if (seen.has(key) || !existsSync(executable)) return false;
    seen.add(key);
    return true;
  }).map(executable => ({ executable, runtime: process.execPath }));
}
