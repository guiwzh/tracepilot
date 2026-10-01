import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import type { Logger, Plugin } from 'vite';
import { debugIdFor, injectDebugId, type RawMap } from './debugId';
import { uploadSourceMaps, type MapFile, type UploadTarget } from './upload';

export { debugIdFor, injectDebugId, registrySnippet } from './debugId';

export interface TracePilotPluginOptions extends UploadTarget {
  /**
   * 上传失败时让构建失败，默认 true。map 没传上去，线上的错误既还原不了源码，
   * 聚合也只能按压缩后的位置进行（同一个 bug 每次发版都成了新 Issue），宁可在构建时就发现。
   */
  failOnError?: boolean;
  /** 只注入 Debug ID、不上传，map 照样不进产物。没有服务端的本地构建用。 */
  dryRun?: boolean;
  /**
   * 这次构建对应的提交，创建版本时一并记下，排障时据此读这个版本的代码、找嫌疑提交。
   * 默认取项目根目录的 git rev-parse HEAD（不在 git 仓库里就不记）；false 表示不记。
   */
  commitSha?: string | false;
}

/** 项目根目录所在 git 仓库的当前提交；不在仓库里、没有 git 时返回 null。 */
function headCommit(root: string): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * TracePilot 的 Vite 构建插件：给每个 JS 产物注入 Debug ID，把 Source Map 上传到服务端，
 * 并且不让 map 进入产物目录。
 *
 *   vite build
 *     ├─ config          把 build.sourcemap 设为 hidden：生成 map，但产物里不写 sourceMappingURL
 *     ├─ generateBundle  逐个产物：由内容算出 Debug ID，注入登记代码和 //# debugId 注释，
 *     │                  map 写入同一个 debugId，然后从 bundle 里拿走（它不会被写进 dist）
 *     └─ writeBundle     产物写盘成功之后，把收集到的 map 上传到「项目 + 版本」下
 *
 * 在 generateBundle 而不是 renderChunk 里注入：这时代码已经压缩完、不会再变，Debug ID 对应的就是
 * 最终部署出去的内容。代价是文件名里的内容哈希是注入之前算的；注入的内容完全由注入前的代码决定，
 * 所以哈希仍然随内容变化，缓存失效不受影响。
 */
export function tracepilotSourceMaps(options: TracePilotPluginOptions): Plugin {
  let logger: Logger | undefined;
  let pending: MapFile[] = [];
  let commitSha: string | null = null;

  return {
    name: 'tracepilot-source-maps',
    apply: 'build',
    enforce: 'post',

    config(config) {
      const configured = config.build?.sourcemap;
      if (configured && configured !== 'hidden') {
        // true 会在产物里写 sourceMappingURL 指向一个已被拿走的文件；inline 直接把源码嵌进产物。
        console.warn(
          `[tracepilot] build.sourcemap: ${String(configured)} is replaced with 'hidden' so source maps never reach the deployed files.`,
        );
      }
      return { build: { sourcemap: 'hidden' } };
    },

    configResolved(resolved) {
      logger = resolved.logger;
      commitSha =
        options.commitSha === false ? null : (options.commitSha ?? headCommit(resolved.root));
    },

    generateBundle(_output, bundle) {
      pending = [];
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        const mapName = chunk.sourcemapFileName ?? `${chunk.fileName}.map`;
        const asset = bundle[mapName];
        if (!asset || asset.type !== 'asset') {
          this.warn(`No source map was generated for ${chunk.fileName}; it gets no debug ID.`);
          continue;
        }
        const raw = JSON.parse(
          typeof asset.source === 'string'
            ? asset.source
            : Buffer.from(asset.source).toString('utf8'),
        ) as RawMap;
        const debugId = debugIdFor(chunk.code);
        const injected = injectDebugId(chunk.code, raw, debugId);
        chunk.code = injected.code;
        // map 只交给服务端，不进入产物目录：它常常内联了全部源码（sourcesContent）。
        delete bundle[mapName];
        pending.push({
          minifiedFile: basename(chunk.fileName),
          debugId,
          content: JSON.stringify(injected.map),
        });
      }
    },

    async writeBundle() {
      const files = pending;
      pending = [];
      if (files.length === 0) return;
      if (options.dryRun) {
        logger?.info(
          `[tracepilot] injected debug IDs into ${files.length} files (dry run, not uploaded)`,
        );
        return;
      }
      try {
        const result = await uploadSourceMaps(options, files, commitSha);
        logger?.info(
          `[tracepilot] uploaded ${result.uploaded} source maps to ${options.projectId}@${options.release}${
            commitSha ? ` (commit ${commitSha.slice(0, 12)})` : ''
          }`,
        );
        if (result.warning) logger?.warn(`[tracepilot] ${result.warning}`);
      } catch (error) {
        const message = `[tracepilot] source map upload failed: ${(error as Error).message}`;
        if (options.failOnError ?? true) throw new Error(message, { cause: error });
        logger?.warn(message);
      }
    },
  };
}
