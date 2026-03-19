/**
 * OS-level sandbox policy generation and subprocess launching.
 *
 * macOS: Uses `sandbox-exec` with Apple Seatbelt profiles.
 *   ⚠️  DEPRECATED: sandbox-exec is deprecated by Apple (works on macOS 15.x).
 *   See TODOS.md for replacement strategy.
 *
 * Linux: Uses `bwrap` (bubblewrap) for filesystem namespace isolation.
 *   Requires user namespace support. Install: `apt install bubblewrap`
 *   On some distros: `sudo setcap cap_sys_admin+ep $(which bwrap)`
 */
import { writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { SpawnOptions } from 'node:child_process';

export interface SandboxConfig {
  agentName: string;
  workspacePath: string;    // Only path the worker can read/write
  proxyPort: number;        // Credential proxy port (only allowed outbound network)
  nodeModulesPath: string;  // node_modules path to allow read access
  nodePath: string;         // Path to node binary
}

/**
 * Returns the spawn args and options to launch `node dist/worker.js`
 * inside a sandbox. The returned `args[0]` is the executable.
 */
export function buildSandboxedSpawn(
  workerScript: string,
  workerArgs: string[],
  env: NodeJS.ProcessEnv,
  cfg: SandboxConfig,
): { cmd: string; args: string[]; spawnOpts: SpawnOptions } {
  const os = platform();
  if (os === 'darwin') {
    return buildMacosSandbox(workerScript, workerArgs, env, cfg);
  }
  if (os === 'linux') {
    return buildLinuxSandbox(workerScript, workerArgs, env, cfg);
  }
  // Fallback: no sandboxing (document clearly)
  console.warn(
    `[sandbox] Unsupported platform '${os}' — running worker WITHOUT sandbox. ` +
      'Agent has full filesystem access.',
  );
  return {
    cmd: cfg.nodePath,
    args: [workerScript, ...workerArgs],
    spawnOpts: { env },
  };
}

// ── macOS (Seatbelt) ──────────────────────────────────────────────────────

function buildMacosSandbox(
  workerScript: string,
  workerArgs: string[],
  env: NodeJS.ProcessEnv,
  cfg: SandboxConfig,
): { cmd: string; args: string[]; spawnOpts: SpawnOptions } {
  const policyPath = writeMacosSeatbeltPolicy(cfg);
  return {
    cmd: '/usr/bin/sandbox-exec',
    args: [
      '-f', policyPath,
      cfg.nodePath, workerScript, ...workerArgs,
    ],
    spawnOpts: { env },
  };
}

function writeMacosSeatbeltPolicy(cfg: SandboxConfig): string {
  mkdirSync(tmpdir(), { recursive: true });
  const path = join(tmpdir(), `monoclaw-${cfg.agentName}.sb`);

  // Discover common Node paths to allow read access.
  // Paths vary by install method (nvm, volta, homebrew, system).
  const nodeDir = dirname(cfg.nodePath);    // e.g. /opt/homebrew/bin
  const nodeRoot = dirname(nodeDir);         // e.g. /opt/homebrew

  // Resolve symlinks so the Seatbelt kernel checks match the canonical paths.
  // On macOS, /var → /private/var and /tmp → /private/tmp.
  const resolvedWorkspace = (() => {
    try { return realpathSync(cfg.workspacePath); } catch { return cfg.workspacePath; }
  })();
  const resolvedNodeModules = (() => {
    try { return realpathSync(cfg.nodeModulesPath); } catch { return cfg.nodeModulesPath; }
  })();
  const resolvedNodeRoot = (() => {
    try { return realpathSync(nodeRoot); } catch { return nodeRoot; }
  })();

  const policy = `
; MonoClaw worker sandbox — ${cfg.agentName}
; ⚠️  sandbox-exec is deprecated by Apple. Works on macOS 15.x.
;
; Design: broadly allow reads so Node can start regardless of install path.
; Security value is in write restriction (workspace only) and network restriction
; (outbound only to credential proxy). This prevents the agent from exfiltrating
; data or writing to arbitrary filesystem locations.
(version 1)
(deny default)

; Allow reading the entire filesystem (Node needs many system paths at startup
; that vary by install method; locking these down causes hard-to-debug hangs)
(allow file-read* (subpath "/"))

; Allow writes only to the agent workspace and node's own temp space
(allow file-write*
  (subpath "${resolvedWorkspace}")
  (subpath "/private/tmp"))

; Allow process execution (node, child processes spawned by tools)
(allow process-exec process-fork)
(allow process-info*)
(allow signal)
(allow mach-lookup)
(allow sysctl-read)
(allow iokit-open)

; Network: only to credential proxy on localhost
(allow network-outbound
  (remote tcp "localhost:${cfg.proxyPort}"))
(allow network-inbound
  (local tcp "localhost:*"))

; IPC
(allow ipc-posix-shm*)
(allow ipc-sysv-shm)
`;
  writeFileSync(path, policy, 'utf-8');
  return path;
}

// ── Linux (bubblewrap) ────────────────────────────────────────────────────

function buildLinuxSandbox(
  workerScript: string,
  workerArgs: string[],
  env: NodeJS.ProcessEnv,
  cfg: SandboxConfig,
): { cmd: string; args: string[]; spawnOpts: SpawnOptions } {
  const nodeDir = dirname(cfg.nodePath);
  const nodeRoot = dirname(nodeDir);

  const bwrapArgs = [
    // Read-only system binds
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', nodeRoot, nodeRoot,
    '--ro-bind', cfg.nodeModulesPath, cfg.nodeModulesPath,
    // Agent workspace: read/write
    '--bind', cfg.workspacePath, cfg.workspacePath,
    // Minimal devices
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    // Namespace isolation
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    // Network: allow (bwrap does not filter by destination; use iptables if needed)
    // '--unshare-net',  // Uncomment to fully block network (breaks LLM API calls)
    '--',
    cfg.nodePath, workerScript, ...workerArgs,
  ];

  return {
    cmd: 'bwrap',
    args: bwrapArgs,
    spawnOpts: { env },
  };
}
