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
const pages = ['setup.html'];

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

describe('phone workbench', () => {
  const index = readFileSync(join(webRoot, 'index.html'), 'utf8');
  const script = readFileSync(join(webRoot, 'chat.js'), 'utf8');

  it('loads an external script under a self-only content policy', () => {
    assert.match(index, /<script src="\/assets\/chat\.js" defer><\/script>/);
    assert.doesNotMatch(index, /<script>|\son\w+="/i);
    assert.doesNotThrow(() => new vm.Script(script, { filename: 'chat.js' }));
  });

  it('keeps the account token out of localStorage so it dies with the tab', () => {
    // Handing the phone to someone, closing the tab, or simply losing the tab to
    // the browser must all end the session: the next visit asks for the password
    // again. sessionStorage gives that, localStorage ("remember me") does not.
    assert.equal(
      /localStorage/.test(script),
      false,
      'the bearer token must not be persisted in localStorage',
    );
    assert.match(script, /TOKEN_KEY = 'rab_token'/);
    assert.match(script, /sessionStorage\.getItem\(key\)/);
  });

  it('recovers the server dashboard without relying on browser-side task history', () => {
    assert.match(script, /\/api\/dashboard/);
    assert.doesNotMatch(script, /rab_pending_tasks/);
  });
});
