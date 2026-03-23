/**
 * Plugin loader — scans config/plugins/ at startup and registers any valid
 * channel plugins found there.
 *
 * Each plugin lives in its own subdirectory:
 *
 *   config/plugins/<name>/
 *     openclaw.plugin.json   — manifest (must contain "id")
 *     index.js               — compiled entry point (result of defineChannelPluginEntry)
 *
 * Override the plugins directory with MONOCLAW_PLUGINS_DIR (consistent with
 * MONOCLAW_DATA_DIR). MonoClaw must otherwise be started from the project root.
 */

import { readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerChannel, getAllChannels } from './channels/index.js';
import type { MonoClawRuntime, PluginEntryResult } from './plugin-sdk.js';

export async function loadPlugins(runtime: MonoClawRuntime): Promise<void> {
  const log = runtime.logger;
  const pluginsDir =
    process.env.MONOCLAW_PLUGINS_DIR ??
    resolve(process.cwd(), 'config', 'plugins');

  let entries: string[];
  let canonPluginsDir: string;
  try {
    entries = (await readdir(pluginsDir)).sort(); // sort for deterministic load order
    canonPluginsDir = await realpath(pluginsDir);
  } catch {
    return; // config/plugins/ doesn't exist — that's fine
  }

  for (const name of entries) {
    const manifestPath = join(pluginsDir, name, 'openclaw.plugin.json');
    let manifest: { id: string; channels?: string[] };
    try {
      const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!raw || typeof raw.id !== 'string' || !raw.id) {
        log.warn({ plugin: name }, 'plugin manifest missing required "id" field — skipping');
        continue;
      }
      manifest = raw as { id: string; channels?: string[] };
    } catch {
      continue; // not a plugin directory (no manifest or invalid JSON)
    }

    // Fast-path duplicate guard — skip before running any plugin code. applyRuntime()
    // could open sockets or timers even if the channel would be rejected as a duplicate.
    if (getAllChannels().find((c) => c.name === manifest.id)) {
      log.warn({ plugin: manifest.id }, 'duplicate channel id — skipping (channel already registered)');
      continue;
    }

    // v1: plugins must ship pre-compiled index.js. TypeScript source requires a
    // build step (e.g. tsc --outDir dist). In dev mode (tsx), you may symlink
    // index.js → index.ts, but this is not officially supported.
    const entryPath = join(pluginsDir, name, 'index.js');
    try {
      // Resolve symlinks and verify the entry stays within pluginsDir. This
      // prevents a symlink like config/plugins/evil → /external/ from loading
      // arbitrary JS outside the plugins directory.
      let canonEntry: string;
      try {
        canonEntry = await realpath(entryPath);
      } catch {
        log.warn({ plugin: name }, 'plugin index.js not found — skipping');
        continue;
      }
      if (!canonEntry.startsWith(canonPluginsDir + sep)) {
        log.warn({ plugin: name }, 'plugin index.js resolves outside plugins directory — skipping');
        continue;
      }
      const mod = await import(pathToFileURL(canonEntry).href);
      const entry = mod.default as PluginEntryResult | undefined;
      if (entry == null) {
        log.warn(
          { plugin: name },
          'plugin has no default export — expected result of defineChannelPluginEntry()',
        );
        continue;
      }
      if (typeof entry.toChannel !== 'function') {
        log.warn(
          { plugin: name },
          'plugin default export is not a PluginEntryResult — did you wrap with defineChannelPluginEntry()?',
        );
        continue;
      }
      await entry.applyRuntime(runtime);
      const channel = entry.toChannel();
      // Validate that toChannel() returned a properly shaped Channel object.
      const missingMethod = (['send', 'onMessage', 'start', 'stop'] as const).find(
        (m) => typeof (channel as Record<string, unknown>)[m] !== 'function',
      );
      if (missingMethod) {
        log.warn({ plugin: name, missingMethod }, 'plugin channel is missing required method — skipping');
        continue;
      }
      // Verify the exported channel name matches the manifest id. A mismatch could
      // allow a plugin to shadow a built-in channel (e.g. exporting name: "telegram").
      if (channel.name !== manifest.id) {
        log.warn(
          { plugin: manifest.id, channelName: channel.name },
          'plugin channel name does not match manifest id — skipping',
        );
        continue;
      }
      // Final duplicate guard (should not fire given the pre-check above, but kept
      // as a safety net in case of registry state changes during loading).
      if (getAllChannels().find((c) => c.name === channel.name)) {
        log.warn(
          { plugin: manifest.id },
          'duplicate channel id — skipping (channel already registered)',
        );
        continue;
      }
      registerChannel(channel);
      log.info({ plugin: manifest.id }, 'loaded plugin channel');
    } catch (err) {
      log.error(
        { plugin: name, err: err instanceof Error ? err.stack : err },
        'failed to load plugin',
      );
    }
  }
}
