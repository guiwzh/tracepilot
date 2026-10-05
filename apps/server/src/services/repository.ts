import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';

/**
 * 只读访问被监控应用的 git 仓库：按某个版本的提交读文件、搜代码、看两个版本之间改了什么、
 * 看出错那一行最后是谁改的。给排障 Agent 和 MCP 的代码类工具用（investigation/tools.ts）。
 *
 * 仓库在哪：服务端配置 REPOSITORY_ROOT 下以项目 id 命名的目录（<root>/<projectId>），
 * 由部署者把仓库克隆或链接到那里。不提供「通过接口设置仓库路径」：管理接口没有鉴权，
 * 能设置任意路径就能让工具读服务器上的任意目录。
 *
 * 安全措施：
 * - 用 execFile 传参数数组调用 git，不经过 shell，参数里的任何字符都不会被解释成命令；
 * - 提交号只接受十六进制，并先确认仓库里有这个提交，之后一律用完整的 40 位提交号；
 *   路径不能是绝对路径、不能含 ..、不能以 - 开头（会被当成 git 的选项），放在 -- 之后，
 *   或者接在提交号后面（<提交号>:<路径>）；
 * - 关掉可能执行外部程序的配置（fsmonitor、外部 diff、textconv），不读系统级 git 配置，不弹出认证提示，
 *   不加可选的锁（只读操作不该在仓库里留下 index.lock）；
 * - 每条命令 5 秒超时、输出有上限。
 */

export type RepositoryErrorCode =
  | 'NO_REPOSITORY'
  | 'NO_COMMIT'
  | 'COMMIT_NOT_FOUND'
  | 'FILE_NOT_FOUND'
  | 'INVALID_PATH'
  | 'GIT_FAILED';

export class RepositoryError extends Error {
  constructor(
    readonly code: RepositoryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const COMMIT = /^[0-9a-f]{7,40}$/i;
const GIT_TIMEOUT_MS = 5_000;

/** 项目的仓库目录；没有配置根目录、项目 id 不像目录名或目录里没有 git 仓库时返回 null。 */
export function projectRepository(root: string | null, projectId: string): string | null {
  if (!root || !/^[\w-]+$/.test(projectId)) return null;
  const path = join(root, projectId);
  return existsSync(join(path, '.git')) || existsSync(join(path, 'HEAD')) ? path : null;
}

function git(repository: string, args: string[], maxBuffer = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '-C',
        repository,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'diff.external=',
        '--no-pager',
        ...args,
      ],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
        },
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/** 确认提交号格式正确且仓库里有这个提交，返回完整的 40 位提交号。 */
async function verifyCommit(repository: string, commit: string | null): Promise<string> {
  if (!commit) throw new RepositoryError('NO_COMMIT', 'This release has no commit recorded.');
  if (!COMMIT.test(commit)) throw new RepositoryError('COMMIT_NOT_FOUND', 'Not a commit id.');
  try {
    return (
      await git(repository, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])
    ).trim();
  } catch {
    throw new RepositoryError(
      'COMMIT_NOT_FOUND',
      `Commit ${commit} is not in the repository (not fetched, or from another repository).`,
    );
  }
}

/** 仓库里的相对路径：去掉开头的 ./，拒绝绝对路径、.. 和以 - 开头的路径。 */
export function safeRepositoryPath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, '/').replace(/^\.\//, ''));
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized.startsWith('-') ||
    normalized.split('/').includes('..')
  ) {
    throw new RepositoryError('INVALID_PATH', `"${path}" is not a path inside the repository.`);
  }
  return normalized;
}

/** 每个提交的文件清单，按提交号缓存（同一个提交的内容不会变）。 */
const fileLists = new Map<string, string[]>();

async function filesAt(repository: string, commit: string): Promise<string[]> {
  const key = `${repository}\u0000${commit}`;
  const cached = fileLists.get(key);
  if (cached) return cached;
  const files = (await git(repository, ['ls-tree', '-r', '--name-only', commit], 8 * 1024 * 1024))
    .split('\n')
    .filter(Boolean);
  if (fileLists.size >= 50) fileLists.clear();
  fileLists.set(key, files);
  return files;
}

/**
 * 把 Source Map 里的源文件名对到仓库里的文件。map 里的路径常带构建工具加的前缀
 * （webpack://app/、../../），不一定是仓库里的相对路径：先按原样找，再找以它结尾、且唯一的文件。
 */
export async function resolveRepositoryFile(
  repository: string,
  commit: string,
  sourcePath: string,
): Promise<string | null> {
  const cleaned = sourcePath
    .replace(/^[a-z]+:\/\/[^/]*\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/^(?:\.{1,2}\/)+/, '');
  if (!cleaned) return null;
  const files = await filesAt(repository, await verifyCommit(repository, commit));
  if (files.includes(cleaned)) return cleaned;
  const matches = files.filter((file) => file.endsWith(`/${cleaned}`));
  return matches.length === 1 ? matches[0]! : null;
}

export interface SourceLines {
  path: string;
  commit: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: string[];
}

/** 读某个提交里一个文件的若干行。 */
export async function readFileAt(
  repository: string,
  commit: string | null,
  path: string,
  startLine: number,
  endLine: number,
): Promise<SourceLines> {
  const full = await verifyCommit(repository, commit);
  const file = safeRepositoryPath(path);
  let content: string;
  try {
    content = await git(repository, ['show', `${full}:${file}`], 4 * 1024 * 1024);
  } catch {
    throw new RepositoryError('FILE_NOT_FOUND', `${file} does not exist at ${full.slice(0, 12)}.`);
  }
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const start = Math.max(1, Math.min(startLine, lines.length));
  const end = Math.max(start, Math.min(endLine, lines.length));
  return {
    path: file,
    commit: full,
    startLine: start,
    endLine: end,
    totalLines: lines.length,
    lines: lines.slice(start - 1, end),
  };
}

export interface CodeMatch {
  path: string;
  line: number;
  text: string;
}

/** 在某个提交的代码里按字面搜索（不是正则），最多 limit 条。 */
export async function searchCodeAt(
  repository: string,
  commit: string | null,
  query: string,
  pathPrefix: string | undefined,
  limit: number,
): Promise<{ commit: string; matches: CodeMatch[]; truncated: boolean }> {
  const full = await verifyCommit(repository, commit);
  const args = ['grep', '-n', '-I', '-F', '--no-color', '-e', query, full];
  if (pathPrefix) args.push('--', safeRepositoryPath(pathPrefix));
  let output: string;
  try {
    output = await git(repository, args);
  } catch (error) {
    // git grep 没有匹配时退出码是 1，不是错误。
    if ((error as { code?: number }).code === 1)
      return { commit: full, matches: [], truncated: false };
    throw new RepositoryError('GIT_FAILED', 'The code search failed.');
  }
  const matches: CodeMatch[] = [];
  const prefix = `${full}:`;
  for (const line of output.split('\n')) {
    if (!line.startsWith(prefix)) continue;
    // 每行形如 <提交>:<路径>:<行号>:<内容>；路径里也可能有冒号，所以从左边按「路径:数字:」匹配。
    const match = /^(.*?):(\d+):(.*)$/.exec(line.slice(prefix.length));
    if (!match) continue;
    matches.push({ path: match[1]!, line: Number(match[2]), text: match[3]!.trim().slice(0, 200) });
  }
  return { commit: full, matches: matches.slice(0, limit), truncated: matches.length > limit };
}

export interface CommitSummary {
  sha: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
}

const FIELD = '\u001f';
const RECORD = '\u001e';

/** from（不含）到 to（含）之间的提交，新的在前。 */
export async function commitsBetween(
  repository: string,
  from: string | null,
  to: string | null,
  limit = 50,
): Promise<CommitSummary[]> {
  const end = await verifyCommit(repository, to);
  const start = from ? await verifyCommit(repository, from) : null;
  const output = await git(repository, [
    'log',
    `--max-count=${limit}`,
    '--no-merges',
    `--format=${RECORD}%H${FIELD}%an${FIELD}%aI${FIELD}%s`,
    '--name-only',
    start ? `${start}..${end}` : end,
  ]);
  return output
    .split(RECORD)
    .filter((block) => block.trim())
    .map((block) => {
      const [header, ...files] = block.split('\n');
      const [sha, author, date, subject] = header!.split(FIELD);
      return {
        sha: sha!,
        author: author!,
        // 与 blameLine 统一成 UTC 的 ISO 格式（git 给的是带时区偏移的写法）。
        date: new Date(date!).toISOString(),
        subject: subject!,
        files: files.map((file) => file.trim()).filter(Boolean),
      };
    });
}

/** 某个提交里，一个文件的一行最后是被哪个提交改的（git blame）。 */
export async function blameLine(
  repository: string,
  commit: string | null,
  path: string,
  line: number,
): Promise<(CommitSummary & { line: number; code: string }) | null> {
  const full = await verifyCommit(repository, commit);
  const file = safeRepositoryPath(path);
  let output: string;
  try {
    output = await git(repository, [
      'blame',
      '--porcelain',
      '--no-textconv',
      '-L',
      `${line},${line}`,
      full,
      '--',
      file,
    ]);
  } catch {
    return null;
  }
  const [first, ...rest] = output.split('\n');
  const sha = first?.split(' ')[0];
  if (!sha || !COMMIT.test(sha)) return null;
  const field = (name: string) =>
    rest.find((entry) => entry.startsWith(`${name} `))?.slice(name.length + 1) ?? '';
  const code = rest.find((entry) => entry.startsWith('\t'))?.slice(1) ?? '';
  const time = Number(field('author-time'));
  return {
    sha,
    author: field('author'),
    date: Number.isFinite(time) ? new Date(time * 1000).toISOString() : '',
    subject: field('summary'),
    files: [file],
    line,
    code: code.trim().slice(0, 200),
  };
}

/** 一个提交对某个文件的改动（统一格式的 diff），截到 maxLines 行。 */
export async function fileDiff(
  repository: string,
  commit: string,
  path: string,
  maxLines = 40,
): Promise<string> {
  const full = await verifyCommit(repository, commit);
  const file = safeRepositoryPath(path);
  const output = await git(repository, [
    'show',
    '--no-ext-diff',
    '--no-textconv',
    '--format=',
    '--unified=2',
    full,
    '--',
    file,
  ]);
  const lines = output
    .split('\n')
    .filter((line) => !line.startsWith('diff --git') && !line.startsWith('index '));
  return lines.slice(0, maxLines).join('\n').trim();
}
