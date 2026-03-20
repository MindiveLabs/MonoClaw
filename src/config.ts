/**
 * Agent configuration loader.
 *
 * Each subdirectory under config/agents/ defines one agent.
 * The directory name is the agent name.
 *
 * Directory layout:
 *   config/agents/<name>/
 *     <name>.json   — agent config (required)
 *     <name>.md     — agent memory / AGENTS.md source (created on first start if absent)
 *     skills/       — drop skill files here; auto-included at startup
 *
 * Schema for <name>.json:
 *   {
 *     "workspacePath": ".runtime/workspaces/alice",   // relative or absolute
 *     "sessionDir":    ".runtime/sessions/alice",     // relative or absolute
 *     "model":         "claude-opus-4-5",             // optional model override
 *     "skills":        ["./extra/skill"],             // optional extra skill paths
 *     "routing": [
 *       { "channel": "telegram", "chatId": "123456789" },
 *       { "channel": "stdio",    "chatId": "alice" }
 *     ]
 *   }
 *
 * The skills/ subdirectory is always prepended to the skills list automatically.
 * Relative paths in "skills" are resolved against process.cwd().
 * memoryPath is derived as <agentDir>/<name>.md.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
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

  const entries = readdirSync(CONFIG_DIR).filter((entry) =>
    statSync(join(CONFIG_DIR, entry)).isDirectory(),
  );
  const configs: AgentFileConfig[] = [];

  for (const name of entries) {
    const agentDir = join(CONFIG_DIR, name);
    const filePath = join(agentDir, `${name}.json`);

    if (!existsSync(filePath)) continue;  // skip dirs without a matching JSON

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

    // Auto-include the agent's skills/ subdirectory if it exists
    const skillsDir = join(agentDir, 'skills');
    const autoSkills = existsSync(skillsDir) ? [skillsDir] : [];
    const allSkills = [...autoSkills, ...(skills?.map(resolvePath) ?? [])];

    configs.push({
      name,
      workspacePath: resolvePath(workspacePath),
      memoryPath: join(agentDir, `${name}.md`),
      sessionDir: resolvePath(sessionDir),
      model,
      skills: allSkills.length ? allSkills : undefined,
      routing,
    });
  }

  return configs;
}
