// The mobile pages are single files with inline scripts and no build step, so
// nothing else in the pipeline would catch a syntax error before a user gets a
// blank screen. Editing them is routine (the whole client lives in one script
// block per page), which is exactly why this guard is worth its two seconds.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pages = ['index.html', 'setup.html'];

describe('inline web scripts', () => {
  for (const page of pages) {
    it(`${page} parses as valid JavaScript`, () => {
      const html = readFileSync(join(webRoot, page), 'utf8');
      const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
      assert.ok(blocks.length > 0, `${page} should contain an inline script`);
      for (const [index, code] of blocks.entries()) {
        assert.doesNotThrow(
          () => new vm.Script(code, { filename: `${page}#${index}` }),
          `${page} script block ${index} has a syntax error`,
        );
      }
    });
  }
});
