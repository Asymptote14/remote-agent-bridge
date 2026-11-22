import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalWorkspace } from '../dist/local-workspace.js';

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), 'rab-local-workspace-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, '工作台');
  const outside = join(directory, 'external');
  const protectedPath = join(root, 'app-data');
  for (const path of [root, protectedPath, outside]) mkdirSync(path);
  writeFileSync(join(protectedPath, 'config.json'), 'private fixture');
  writeFileSync(join(outside, 'outside.txt'), 'external fixture');
  writeFileSync(join(root, 'note.txt'), '正常 UTF-8 文本');
  return { root, outside, workspace: new LocalWorkspace(root, () => [protectedPath]) };
}

test('allows only ordinary text inside the configured workspace and honors abort', async context => {
  const { root, workspace } = fixture(context);
  writeFileSync(join(root, 'bad.txt'), Buffer.from([0xff, 0x01]));
  writeFileSync(join(root, 'credentials.json'), 'private fixture');
  assert.equal(await workspace.readText('./note.txt'), '正常 UTF-8 文本');
  await assert.rejects(workspace.readText('bad.txt'), /text_file_required/);
  for (const path of ['../external/outside.txt', '..\\external\\outside.txt', join(root, 'note.txt')]) {
    await assert.rejects(workspace.readText(path), /path_outside_workspace|path_not_allowed/);
  }
  await assert.rejects(workspace.readText('app-data/config.json'), /path_not_allowed/);
  await assert.rejects(workspace.readText('credentials.json'), /path_not_allowed/);
  const listing = await workspace.list('.');
  assert.match(listing, /note\.txt/);
  assert.doesNotMatch(listing, /credentials|app-data/);
  const reason = new Error('cancelled by fixture');
  await assert.rejects(workspace.readText('note.txt', AbortSignal.abort(reason)), reason);
});

test('does not follow directory links or read multiply linked files', async context => {
  const { root, outside, workspace } = fixture(context);
  symlinkSync(outside, join(root, 'directory-link'), process.platform === 'win32' ? 'junction' : 'dir');
  linkSync(join(outside, 'outside.txt'), join(root, 'hardlink.txt'));
  await assert.rejects(workspace.readText('directory-link/outside.txt'), /path_link_not_allowed/);
  await assert.rejects(workspace.list('directory-link'), /path_link_not_allowed/);
  await assert.rejects(workspace.readText('hardlink.txt'), /not_a_regular_file/);
  assert.doesNotMatch(await workspace.list('.'), /directory-link/);
});

test('truncates bounded reads at a UTF-8 boundary and caps directory results', async context => {
  const { root, workspace } = fixture(context);
  writeFileSync(join(root, 'large.txt'), '字'.repeat(100_000));
  const content = await workspace.readText('large.txt');
  assert.equal(content.split('\n')[0], '字'.repeat(Math.floor(16 * 1024 / 3)));
  assert.match(content, /内容已截断/);
  for (let index = 0; index < 110; index += 1) writeFileSync(join(root, `test-${index}.txt`), 'fixture');
  const lines = (await workspace.list('.')).split('\n');
  assert.equal(lines.filter(line => line.startsWith('[文件]')).length, 100);
  assert.match(lines.at(-1), /内容已截断/);
});
