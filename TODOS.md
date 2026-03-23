# TODOS

## npm-installable plugins

**Let developers install MonoClaw plugins via npm.**

Currently plugins must be copied into `config/plugins/<name>/` as local directories. A natural next step is supporting plugins declared in a `config/plugins.json` (or `package.json` dependencies) and loaded from `node_modules`.

**Why:** Enables a distribution story — `npm install monoclaw-plugin-discord` plus a config entry, and the channel is live on restart. Makes plugin sharing trivial.

**Pros:** Community ecosystem; plugins are versioned and updatable like any npm package.

**Cons:** Adds a new config surface (`config/plugins.json`); ~150 more lines in core; plugin authors need to publish to npm.

**Context:** The plugin system (v1) was intentionally scoped to directory-based loading to stay under 200 new lines. npm loading is Approach C from the design doc. The loader already dynamically imports `index.js` — the main addition is scanning `node_modules` and a `config/plugins.json` to declare which packages to load.

**Where to start:** `src/plugin-loader.ts` — add a second scan after the directory scan; read `config/plugins.json` for package names; import `<pkg>/dist/index.js` from `node_modules`.

**Depends on:** v1 plugin system (done).

---

## macOS sandbox deprecation

**Replace `sandbox-exec` with a non-deprecated macOS sandboxing mechanism.**

`sandbox-exec` is officially deprecated by Apple and may be removed in a future macOS release. MonoClaw currently uses it as the primary isolation primitive on macOS.

**Why:** Without a replacement, MonoClaw's macOS isolation story fails on whatever version Apple drops the API.

**Pros:** Future-proof. Modern Endpoint Security framework or Landlock (Linux) offer robust isolation.

**Cons:** Significant complexity. Endpoint Security requires a system extension (code-signing, notarization). Landlock is Linux-only. No drop-in replacement for Seatbelt exists yet.

**Context:** `sandbox-exec` currently works on macOS 15.x (confirmed). The deprecation warning exists in Apple docs but removal timeline is unknown. MonoClaw documents this limitation in README. Re-evaluate when target users report issues or when Apple announces a removal date.

**Where to start:** `src/sandbox.ts` — watch Apple release notes; evaluate Landlock for the Linux path when that becomes a priority.

**Depends on:** macOS version landscape among MonoClaw users.
