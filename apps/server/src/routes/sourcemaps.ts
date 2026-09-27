import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config';
import type { TraceDatabase } from '../db/client';
import { InvalidSourceMapError, listSourceMaps, saveSourceMap } from '../services/sourcemaps';

/**
 * Source Map 接口：列出某个版本已上传的 map、上传新的 map。
 *
 * 上传使用 multipart/form-data（浏览器 <form> 或 FormData 上传文件的格式）：一个请求里同时带
 * 普通字段（minifiedFile：这个 map 对应线上哪个压缩文件）和文件本体（.map）。
 * 解析由 app.ts 注册的 @fastify/multipart 插件完成。
 */
function releaseId(params: unknown): string {
  return String((params as { releaseId?: string }).releaseId ?? '');
}

function fieldValue(fields: Record<string, unknown>, name: string): string {
  // @fastify/multipart 将普通字段包装成 part 对象，value 才是表单字符串。
  const field = fields[name];
  if (field && typeof field === 'object' && 'value' in field) {
    return String((field as { value: unknown }).value);
  }
  return '';
}

export function registerSourceMapRoutes(
  app: FastifyInstance,
  database: TraceDatabase,
  config: ServerConfig,
): void {
  app.get('/api/v1/releases/:releaseId/source-maps', async (request, reply) => {
    const id = releaseId(request.params);
    const release = database.sqlite.prepare('SELECT 1 FROM releases WHERE id = ?').get(id);
    if (!release)
      return reply.code(404).send({ error: 'RELEASE_NOT_FOUND', message: 'Release not found.' });
    return { items: listSourceMaps(database, id) };
  });

  app.post('/api/v1/releases/:releaseId/source-maps', async (request, reply) => {
    const id = releaseId(request.params);
    const release = database.sqlite.prepare('SELECT 1 FROM releases WHERE id = ?').get(id);
    if (!release)
      return reply.code(404).send({ error: 'RELEASE_NOT_FOUND', message: 'Release not found.' });
    // request.file() 取出请求里的第一个文件。上传是以流的形式到达的，
    // 这里的限制在读取过程中就生效：超过 10 MB 会中途报错，而不是先把整个文件读进内存再判断。
    const part = await request.file({
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4 },
    });
    if (!part) {
      return reply
        .code(400)
        .send({ error: 'SOURCE_MAP_REQUIRED', message: 'Attach one .map file.' });
    }
    const minifiedFile = fieldValue(part.fields as Record<string, unknown>, 'minifiedFile');
    if (!minifiedFile) {
      return reply
        .code(400)
        .send({ error: 'MINIFIED_FILE_REQUIRED', message: 'Provide the minified file name.' });
    }
    // 415 Unsupported Media Type：请求格式本身没问题，但上传的文件类型不被接受。
    if (!part.filename.endsWith('.map')) {
      return reply
        .code(415)
        .send({ error: 'INVALID_SOURCE_MAP_FILE', message: 'Only .map files are accepted.' });
    }
    try {
      // toBuffer() 把整个文件读进内存（已被上面的 10 MB 上限约束）。
      // saveSourceMap 还会验证 JSON、version 和 mappings，扩展名检查不是唯一防线。
      const record = await saveSourceMap(
        database,
        config.sourceMapDir,
        id,
        minifiedFile,
        await part.toBuffer(),
      );
      return reply.code(201).send(record);
    } catch (error) {
      // 只有文件本身不合格才是 400；磁盘写入失败等服务端问题交给统一错误处理返回 500，
      // 不能让上传方误以为是自己的 map 有问题。
      if (!(error instanceof InvalidSourceMapError)) throw error;
      request.log.warn({ err: error }, 'invalid source map upload');
      return reply.code(400).send({
        error: 'INVALID_SOURCE_MAP',
        message: 'The uploaded file is not a valid version 3 source map.',
      });
    }
  });
}
