/**
 * 自动部署 Claude Code Skills
 *
 * 将 skills/ 目录下的 Skill 文件夹 symlink 到 ~/.claude/skills/
 */

import { existsSync, mkdirSync, symlinkSync, unlinkSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function deploySkills() {
  const skillsSource = resolve(__dirname, '../../skills');
  const skillsTarget = resolve(homedir(), '.claude/skills');

  if (!existsSync(skillsTarget)) mkdirSync(skillsTarget, { recursive: true });
  if (!existsSync(skillsSource)) {
    console.log(chalk.yellow('  ⚠️ 无 Skills 目录，跳过'));
    return;
  }

  const dirs = readdirSync(skillsSource, { withFileTypes: true }).filter(d => d.isDirectory());

  for (const dir of dirs) {
    const src = join(skillsSource, dir.name);
    const dst = join(skillsTarget, dir.name);

    // 已存在则跳过（不覆盖用户自定义）
    if (existsSync(dst)) {
      console.log(chalk.gray(`  ⏭️  ${dir.name} (已存在)`));
      continue;
    }

    try {
      symlinkSync(src, dst, 'dir');
      console.log(chalk.green(`  ✅ ${dir.name}`));
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠️ ${dir.name}: ${err.message}`));
    }
  }
}
