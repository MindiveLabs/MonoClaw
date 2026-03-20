/**
 * Agent configuration loader.
 *
 * Each file in config/agents/*.json defines one agent.
 * The filename (without .json) is the agent name.
 *
 * Schema:
 *   {
 *     "workspacePath": ".runtime/workspaces/alice",   // relative or absolute
 *     "sessionDir":    ".runtime/sessions/alice",     // relative or absolute
 *     "model":         "claude-opus-4-5",             // optional model override
 *     "skills":        ["./skills/my-skill"],         // optional skill paths
 *     "routing": [
 *       { "channel": "telegram", "chatId": "123456789" },
 *       { "channel": "stdio",    "chatId": "alice" }
 *     ]
 *   }
 *
 * memoryPath is derived automatically as <workspacePath>/AGENTS.md.
 * Relative paths are resolved against process.cwd().
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, isAbsolute, resolve, basename } from 'node:path';
import { z } from 'zod';
import type { AgentConfig } from './types.js';

const CONFIG_DIR = join(process.cwd(), 'config', 'agents');

const RoutingEntrySchema = z.object({
  channel: z.string().min(1),
  chatId: z.string().min(1),
});

const AgentFileSchema = z.object({
  workspacePath: z.string().min(1),
  sessionDir: z.string().min(1),
  model: z.string().optional(),
  skills: z.array(z.string()).optional(),
  routing: z.array(RoutingEntrySchema).default([]),
});

export interface AgentRoutingEntry {
  channel: string;
  chatId: string;
}

export interface AgentFileConfig extends AgentConfig {
  routing: AgentRoutingEntry[];
}

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

export function loadAgentConfigs(): AgentFileConfig[] {
  if (!existsSync(CONFIG_DIR)) {
    return [];
  }

  const files = readdirSync(CONFIG_DIR).filter((f) => f.endsWith('.json'));
  const configs: AgentFileConfig[] = [];

  for (const file of files) {
    const filePath = join(CONFIG_DIR, file);
    const name = basename(file, '.json');

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch (err) {
      throw new Error(
        `Failed to parse agent config ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = AgentFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Invalid agent config ${filePath}: ${parsed.error.message}`,
      );
    }

    const { workspacePath, sessionDir, model, skills, routing } = parsed.data;
    const resolvedWorkspace = resolvePath(workspacePath);

    configs.push({
      name,
      workspacePath: resolvedWorkspace,
      // Source of truth for agent memory lives next to the config JSON so it
      // is easy to find and edit. agent.ts copies it into the workspace on
      // each startup so pimono discovers it via its AGENTS.md walk.
      memoryPath: join(CONFIG_DIR, `${name}.md`),
      sessionDir: resolvePath(sessionDir),
      model,
      skills: skills?.map(resolvePath),
      routing,
    });
  }

  return configs;
}
