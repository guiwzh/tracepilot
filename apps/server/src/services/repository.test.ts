import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDemoRepository } from '../demo/repository';
import {
  blameLine,
  commitsBetween,
  fileDiff,
  projectRepository,
  readFileAt,
  RepositoryError,
  resolveRepositoryFile,
  safeRepositoryPath,
  searchCodeAt,
} from './repository';

const HOUR = 3_600_000;
let root: string;
let repository: string;
let commits: { previous: string; current: string };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tracepilot-repo-'));
  const now = Date.now();
  commits = createDemoRepository(root, 'demo-project', {
    previous: now - 120 * HOUR,
    current: now - 26 * HOUR,
  })!;
  repository = projectRepository(root, 'demo-project')!;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('read-only repository access', () => {
  it('finds a project repository only under the configured root', () => {
    expect(repository).toBe(join(root, 'demo-project'));
    expect(projectRepository(root, 'other-project')).toBeNull();
    expect(projectRepository(null, 'demo-project')).toBeNull();
    // 项目 id 不能把路径带出根目录。
    expect(projectRepository(root, '../demo-project')).toBeNull();
  });

  it('reads a file as it was in each release', async () => {
    const before = await readFileAt(repository, commits.previous, 'src/checkout/total.ts', 1, 200);
    const after = await readFileAt(repository, commits.current, 'src/checkout/total.ts', 1, 200);
    expect(before.lines.join('\n')).toContain('cart.summary?.total ?? sumItems(cart)');
    expect(after.lines.join('\n')).toContain('const subtotal = cart.summary.total;');
    const slice = await readFileAt(repository, commits.current, './src/checkout/total.ts', 21, 23);
    expect(slice).toMatchObject({ startLine: 21, endLine: 23 });
    expect(slice.lines).toHaveLength(3);
  });

  it('refuses paths and commits that could escape the repository or inject options', async () => {
    for (const path of ['../secrets', '/etc/passwd', '-p', 'src/../../x']) {
      expect(() => safeRepositoryPath(path)).toThrow(RepositoryError);
    }
    await expect(
      readFileAt(repository, '--all', 'src/checkout/total.ts', 1, 2),
    ).rejects.toMatchObject({
      code: 'COMMIT_NOT_FOUND',
    });
    // 版本的提交号由接口登记，可以是任意字符串。
    await expect(
      resolveRepositoryFile(repository, '--all', 'src/checkout/total.ts'),
    ).rejects.toMatchObject({ code: 'COMMIT_NOT_FOUND' });
    await expect(readFileAt(repository, null, 'src/checkout/total.ts', 1, 2)).rejects.toMatchObject(
      {
        code: 'NO_COMMIT',
      },
    );
    await expect(
      readFileAt(repository, commits.current, 'src/missing.ts', 1, 2),
    ).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
  });

  it('searches literal text at a commit', async () => {
    const result = await searchCodeAt(
      repository,
      commits.current,
      'summary?: CartSummary',
      undefined,
      20,
    );
    expect(result.matches).toEqual([
      expect.objectContaining({ path: 'src/api/types.ts', text: 'summary?: CartSummary;' }),
    ]);
    // 正则元字符按字面匹配；没有匹配不是错误。
    expect(
      (await searchCodeAt(repository, commits.current, 'a.*b(', undefined, 20)).matches,
    ).toEqual([]);
    const scoped = await searchCodeAt(repository, commits.current, 'export', 'src/lib', 20);
    expect(scoped.matches.every((match) => match.path.startsWith('src/lib/'))).toBe(true);
  });

  it('maps source map paths to repository files', async () => {
    expect(await resolveRepositoryFile(repository, commits.current, 'src/checkout/total.ts')).toBe(
      'src/checkout/total.ts',
    );
    expect(
      await resolveRepositoryFile(repository, commits.current, '../../src/checkout/total.ts'),
    ).toBe('src/checkout/total.ts');
    expect(
      await resolveRepositoryFile(
        repository,
        commits.current,
        'webpack://checkout/checkout/total.ts',
      ),
    ).toBe('src/checkout/total.ts');
    expect(await resolveRepositoryFile(repository, commits.current, 'src/nowhere.ts')).toBeNull();
  });

  it('lists the commits between two releases and blames the failing line', async () => {
    const between = await commitsBetween(repository, commits.previous, commits.current);
    expect(between.map((commit) => commit.subject)).toEqual([
      'release: checkout 2.4.1',
      'perf(checkout): reuse the cart summary total instead of re-summing items',
      'feat(checkout): show the delivery window on the review step',
    ]);
    expect(between[1]).toMatchObject({ author: 'Lin Wei', files: ['src/checkout/total.ts'] });

    const after = await readFileAt(repository, commits.current, 'src/checkout/total.ts', 1, 200);
    const line = after.lines.findIndex((text) => text.includes('cart.summary.total')) + 1;
    const blame = await blameLine(repository, commits.current, 'src/checkout/total.ts', line);
    expect(blame).toMatchObject({
      sha: between[1]!.sha,
      author: 'Lin Wei',
      code: 'const subtotal = cart.summary.total;',
    });
    const diff = await fileDiff(repository, between[1]!.sha, 'src/checkout/total.ts');
    expect(diff).toContain('-  const subtotal = cart.summary?.total ?? sumItems(cart);');
    expect(diff).toContain('+  const subtotal = cart.summary.total;');
  });

  it('never runs a textconv driver while blaming', async () => {
    // .gitattributes 能给文件指定 diff 驱动，驱动的 textconv 是任意命令；git blame 默认会执行它。
    const directory = join(root, 'textconv-project');
    const marker = join(root, 'textconv-ran');
    const run = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'Mei Chen',
          GIT_AUTHOR_EMAIL: 'mei.chen@shop.example',
          GIT_COMMITTER_NAME: 'Mei Chen',
          GIT_COMMITTER_EMAIL: 'mei.chen@shop.example',
        },
      }).trim();
    mkdirSync(directory);
    run('init', '--quiet');
    writeFileSync(join(directory, '.gitattributes'), 'notes.txt diff=evil\n');
    writeFileSync(join(directory, 'notes.txt'), 'first line\n');
    run('add', '--all');
    run('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', 'add notes');
    const sha = run('rev-parse', 'HEAD');
    run('config', 'diff.evil.textconv', `touch '${marker}' && cat`);

    const blame = await blameLine(
      projectRepository(root, 'textconv-project')!,
      sha,
      'notes.txt',
      1,
    );
    expect(blame).toMatchObject({ sha, code: 'first line' });
    expect(existsSync(marker)).toBe(false);
  });
});
