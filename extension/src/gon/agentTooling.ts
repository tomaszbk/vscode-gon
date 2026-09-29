// Copyright 2026 The Gon Authors. Licensed under the MIT license.
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

export interface ToolingCapabilities {
  schemaVersion: 1;
  operation: 'capabilities';
  capabilities: {
    queries: string[];
    rename: boolean;
    check: boolean;
    persistent: boolean;
  };
  toolchain: { root: string; languageServer: string };
}

export type ToolingProbe = { available: true; result: ToolingCapabilities } | { available: false; reason: string };

export function parseCapabilities(text: string): ToolingCapabilities {
  const value = JSON.parse(text) as Partial<ToolingCapabilities>;
  if (!value || value.schemaVersion !== 1) {
    throw new Error('The selected Gon tools do not support capability schema version 1.');
  }
  const capabilities = value.capabilities;
  const toolchain = value.toolchain;
  if (
    value.operation !== 'capabilities' ||
    !capabilities ||
    !Array.isArray(capabilities.queries) ||
    !capabilities.queries.every((query) => typeof query === 'string') ||
    !['rename', 'check', 'persistent'].every((name) => typeof capabilities[name as keyof typeof capabilities] === 'boolean') ||
    !toolchain ||
    typeof toolchain.root !== 'string' ||
    !path.isAbsolute(toolchain.root) ||
    typeof toolchain.languageServer !== 'string' ||
    !path.isAbsolute(toolchain.languageServer)
  ) {
    throw new Error('The selected Gon tools returned an invalid capabilities response.');
  }
  return value as ToolingCapabilities;
}

export async function probeCapabilities(executable: string, directory: string): Promise<ToolingProbe> {
  try {
    const { stdout } = await promisify(execFile)(executable, ['capabilities', '--json'], {
      cwd: directory,
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });
    return { available: true, result: parseCapabilities(stdout) };
  } catch (error) {
    return {
      available: false,
      reason: `${error instanceof Error ? error.message : String(error)} Update the selected Gon toolchain for agent tooling, then run Gon: Restart Language Server.`
    };
  }
}
