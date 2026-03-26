/**
 * Claude Code detection, auto-install, and auth check.
 *
 * 1. Is `claude` command available?
 * 2. If not, auto-install via npm
 * 3. Is it authenticated?
 */

import { spawn, execSync } from 'child_process';
import chalk from 'chalk';

interface ClaudeStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
}

/**
 * Check if claude CLI is available and return its status.
 */
export async function checkClaude(): Promise<ClaudeStatus> {
  const status: ClaudeStatus = { installed: false, version: null, authenticated: false };

  // Check if claude command exists
  const version = await runCommand('claude', ['--version']);
  if (!version) return status;

  status.installed = true;
  status.version = version.trim().split('\n')[0];

  // Check authentication via `claude auth status` (JSON output)
  const authOutput = await runCommand('claude', ['auth', 'status'], { timeout: 10_000 });
  if (authOutput) {
    try {
      const auth = JSON.parse(authOutput);
      status.authenticated = auth.loggedIn === true;
    } catch {
      // If not JSON, check for text indicators
      status.authenticated = authOutput.includes('loggedIn') || authOutput.includes('true');
    }
  }

  return status;
}

/**
 * Attempt to auto-install Claude Code via npm.
 * Returns true if installation succeeded.
 */
export async function installClaude(): Promise<boolean> {
  console.log(chalk.cyan('  📦 Installing Claude Code (@anthropic-ai/claude-code)...'));
  console.log(chalk.gray('  This may take a minute...'));

  try {
    execSync('npm install -g @anthropic-ai/claude-code', {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });

    // Verify installation
    const version = await runCommand('claude', ['--version']);
    if (version) {
      console.log(chalk.green(`  ✅ Claude Code installed: ${version.trim().split('\n')[0]}`));
      return true;
    }
    return false;
  } catch (err: any) {
    console.error(chalk.red(`  ❌ Installation failed: ${err.message?.slice(0, 100)}`));
    console.log(chalk.gray('  Try manually: npm install -g @anthropic-ai/claude-code'));
    return false;
  }
}

/**
 * Full check + auto-install + auth guidance flow.
 * Used in both `init` and `start` commands.
 *
 * Returns true if Claude Code is ready to use.
 */
export async function ensureClaude(interactive: boolean = true): Promise<boolean> {
  console.log(chalk.cyan('  🔍 Checking Claude Code...'));

  let status = await checkClaude();

  // Step 1: Install if not found
  if (!status.installed) {
    console.log(chalk.yellow('  ⚠️  Claude Code not found.'));

    if (interactive) {
      // In init wizard, auto-install
      const installed = await installClaude();
      if (!installed) {
        console.log(chalk.red('  Claude Code is required for local execution features.'));
        console.log(chalk.gray('  Install manually: npm install -g @anthropic-ai/claude-code'));
        return false;
      }
      status = await checkClaude();
    } else {
      console.log(chalk.gray('  Install: npm install -g @anthropic-ai/claude-code'));
      return false;
    }
  } else {
    console.log(chalk.gray(`  ✓ Claude Code ${status.version}`));
  }

  // Step 2: Check auth
  if (!status.authenticated) {
    console.log(chalk.yellow('  ⚠️  Claude Code is not authenticated.'));
    console.log(chalk.bold('  👉 Please run `claude` in your terminal to log in first.'));
    console.log(chalk.gray('  (Opens browser for authentication, requires Pro/Max subscription or API key)'));
    return false;
  }

  console.log(chalk.gray('  ✓ Authenticated'));
  return true;
}

// ═══ Helpers ═══

function runCommand(cmd: string, args: string[], opts?: { input?: string; timeout?: number }): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: opts?.timeout || 10_000,
      });

      let stdout = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });

      if (opts?.input) {
        child.stdin.write(opts.input);
        child.stdin.end();
      } else {
        child.stdin.end();
      }

      const timer = setTimeout(() => {
        child.kill();
        resolve(stdout || null);
      }, opts?.timeout || 10_000);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? stdout : null);
      });

      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}
