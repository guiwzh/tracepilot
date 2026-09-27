import type { FastifyInstance, FastifyRequest } from 'fastify';
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

/** 上传请求里的内容：唯一的文件，以及 minifiedFile 字段。 */
interface UploadParts {
  file?: { filename: string; content: Buffer };
  minifiedFile: string;
}

/**
 * 按顺序读完请求里的每一部分，字段和文件的先后不限。
 *
 * 曾经用 request.file() 只取第一个文件，再从它身上读已经到达的字段：字段排在文件之后时，
 * 读到文件的那一刻字段还没解析到，于是返回「请提供 minifiedFile」——而它明明在请求里。
 * 小文件往往整个请求一次到齐，看不出问题；几 MB 的真实 map 分块到达时必然失败，
 * 同一条 curl -F file=@… -F minifiedFile=… 命令会随文件大小时好时坏。
 */
async function readUpload(request: FastifyRequest): Promise<UploadParts> {
  const upload: UploadParts = { minifiedFile: '' };
  // 限制在读取过程中就生效：文件超过 10 MB 会中途报错（413），而不是先把整个文件读进内存再判断。
  for await (const part of request.parts({
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4 },
  })) {
    if (part.type === 'file') {
      // toBuffer() 把文件读进内存（已被上面的 10 MB 上限约束）；读完才会继续解析后面的部分。
      upload.file = { filename: part.filename, content: await part.toBuffer() };
    } else if (part.fieldname === 'minifiedFile') {
      upload.minifiedFile = String(part.value);
    }
  }
  return upload;
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
    const { file, minifiedFile } = await readUpload(request);
    if (!file) {
      return reply
        .code(400)
        .send({ error: 'SOURCE_MAP_REQUIRED', message: 'Attach one .map file.' });
    }
    if (!minifiedFile) {
      return reply
        .code(400)
        .send({ error: 'MINIFIED_FILE_REQUIRED', message: 'Provide the minified file name.' });
    }
    // 415 Unsupported Media Type：请求格式本身没问题，但上传的文件类型不被接受。
    if (!file.filename.endsWith('.map')) {
      return reply
        .code(415)
        .send({ error: 'INVALID_SOURCE_MAP_FILE', message: 'Only .map files are accepted.' });
    }
    try {
      // saveSourceMap 还会验证 JSON、version 和每一条映射，扩展名检查不是唯一防线。
      const record = await saveSourceMap(
        database,
        config.sourceMapDir,
        id,
        minifiedFile,
        file.content,
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
