# Vendored `@yolo-labs/app-sdk` (browser ESM)

`client.js` + `envelope.js` are copied verbatim from the built
[`@yolo-labs/app-sdk`](https://github.com/yolo-labs-hq/app-sdk) `dist/` and served as a static ES module from this tile-app's
own surface. videostitcher dogfoods the SDK: `index.html` loads
`./vendor/app-sdk/client.js` and uses `createTileApp()` for the host bridge
(workspace-file import via `fs.*`, env-profile events) instead of a hand-rolled
postMessage.

**Why vendored (not imported from node_modules):** videostitcher's surface is a
static `public/` dir served as-is (no bundler). The SDK's `dist` is already browser-importable ESM (built with
explicit `.js` specifiers), so a verbatim copy is the simplest delivery that
works both locally and in the container (the Dockerfile COPYs `public/`).

**Regenerate after any SDK change** (builds the sibling `packages/app-sdk` in the
monorepo; anywhere else, copies from the `@yolo-labs/app-sdk` devDependency):

```
cd packages/videostitcher && npm run vendor:sdk
```

Do not hand-edit these files.
