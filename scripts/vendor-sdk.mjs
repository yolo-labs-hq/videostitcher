/**
 * Copy @yolo-labs/app-sdk's browser build into public/vendor/app-sdk/.
 *
 * The tile-app surface is a static public/ dir with no bundler, so index.html
 * imports the SDK by path. Inside the monorepo this builds the sibling
 * packages/app-sdk source, so the demo always dogfoods the current SDK. In the
 * standalone public mirror (github.com/yolo-labs-hq/videostitcher) that sibling
 * doesn't exist, so it copies from the published @yolo-labs/app-sdk
 * devDependency instead.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../public/vendor/app-sdk');
const sibling = resolve(here, '../../app-sdk');

let dist;
if (existsSync(join(sibling, 'package.json'))) {
  execFileSync('npm', ['run', 'build'], { cwd: sibling, stdio: 'inherit' });
  dist = join(sibling, 'dist');
} else {
  dist = dirname(fileURLToPath(import.meta.resolve('@yolo-labs/app-sdk')));
}

mkdirSync(target, { recursive: true });
for (const file of ['client.js', 'envelope.js']) copyFileSync(join(dist, file), join(target, file));
console.log(`[vendor-sdk] copied client.js + envelope.js from ${dist}`);
