// ACP Registry fetching and parsing
import { existsSync } from 'fs';
import https from 'https';
import path from 'path';

export interface AcpAgent {
  id: string;
  name: string;
  version: string;
  description?: string;
  distribution: {
    npx?: {
      package: string;
      args?: string[];
    };
    binary?: Record<string, {
      archive: string;
      cmd: string;
      args?: string[];
      env?: Record<string, string>;
    }>;
  };
  icon?: string;
}

export interface AcpRegistry {
  version: string;
  agents: AcpAgent[];
  extensions: any[];
}

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

export function fetchRegistry(): Promise<AcpRegistry> {
  return new Promise((resolve, reject) => {
    https.get(REGISTRY_URL, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const registry = JSON.parse(data);
          resolve(registry);
        } catch (err) {
          reject(new Error(`Failed to parse registry: ${err}`));
        }
      });
    }).on('error', reject);
  });
}

export function findAgent(registry: AcpRegistry, agentId: string): AcpAgent | undefined {
  return registry.agents.find(a => a.id === agentId);
}

export function getPlatformKey(): string {
  const platform = process.platform;
  const arch = process.arch;
  
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64';
  } else if (platform === 'linux') {
    return arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64';
  } else if (platform === 'win32') {
    return arch === 'arm64' ? 'windows-aarch64' : 'windows-x86_64';
  }
  
  return 'unknown';
}

export function getAgentCommand(agent: AcpAgent): { command: string; args: string[] } | null {
  const platform = getPlatformKey();
  
  // Prefer local node_modules for npm packages to avoid download delays
  if (agent.distribution.npx) {
    let pkg = agent.distribution.npx.package;
    const lastAtIndex = pkg.lastIndexOf('@');
    if (lastAtIndex > 0) {
      pkg = pkg.substring(0, lastAtIndex);
    }
    
    // Try to use local node_modules installation first
    try {
      const localPath = require.resolve(pkg + '/package.json');
      const packageDir = path.dirname(localPath);
      const packageJson = require(localPath);
      const bin = packageJson.bin;
      
      if (typeof bin === 'string') {
        return {
          command: 'node',
          args: [path.join(packageDir, bin), ...(agent.distribution.npx.args || [])]
        };
      } else if (bin && typeof bin === 'object') {
        const binName = Object.keys(bin)[0] as keyof typeof bin;
        const binPath = bin[binName];
        if (!binPath) {
          throw new Error(`Bin entry for ${String(binName)} not found`);
        }
        return {
          command: 'node',
          args: [path.join(packageDir, binPath), ...(agent.distribution.npx.args || [])]
        };
      }
    } catch (e) {
      // Fall back to bunx if local package not found
      console.log('Local package not found, falling back to bunx');
    }
    
    return {
      command: 'bunx',
      args: [pkg, ...(agent.distribution.npx.args || [])]
    };
  }
  
  // Fall back to binary
  if (agent.distribution.binary && agent.distribution.binary[platform]) {
    const binary = agent.distribution.binary[platform];
    // The registry's `cmd` is typically a relative path (e.g. "./opencode")
    // assuming the archive has been downloaded and extracted to cwd. We don't
    // do that download, so if the relative file doesn't exist, fall back to
    // looking up the basename on PATH (e.g. a global install).
    const command = resolveBinaryCommand(binary.cmd);
    return {
      command,
      args: binary.args || []
    };
  }

  return null;
}

function resolveBinaryCommand(rawCmd: string): string {
  const looksRelative = rawCmd.startsWith('./') || rawCmd.startsWith('.\\');
  if (!looksRelative) {
    return rawCmd;
  }
  if (existsSync(rawCmd)) {
    return rawCmd;
  }
  const basename = path.basename(rawCmd);
  const resolved = findOnPath(basename);
  return resolved ?? rawCmd;
}

function findOnPath(binaryName: string): string | null {
  const pathEnv = process.env.PATH;
  if (!pathEnv) {
    return null;
  }
  const separator = process.platform === 'win32' ? ';' : ':';
  const isWindows = process.platform === 'win32';
  const candidates = isWindows
    ? [binaryName, `${binaryName}.exe`, `${binaryName}.cmd`, `${binaryName}.bat`]
    : [binaryName];
  for (const dir of pathEnv.split(separator)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const candidatePath = path.join(dir, candidate);
      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    }
  }
  return null;
}
