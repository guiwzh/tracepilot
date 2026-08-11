import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config';
import type { TraceDatabase } from '../db/client';
import { listSourceMaps, saveSourceMap } from '../services/sourcemaps';

function releaseId(params: unknown): string {
  return String((params as { releaseId?: string }).releaseId ?? '');
}

function fieldValue(fields: Record<string, unknown>, name: string): string {
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
    if (!part.filename.endsWith('.map')) {
      return reply
        .code(415)
        .send({ error: 'INVALID_SOURCE_MAP_FILE', message: 'Only .map files are accepted.' });
    }
    try {
      const record = await saveSourceMap(
        database,
        config.sourceMapDir,
        id,
        minifiedFile,
        await part.toBuffer(),
      );
      return reply.code(201).send(record);
    } catch (error) {
      request.log.warn({ err: error }, 'invalid source map upload');
      return reply.code(400).send({
        error: 'INVALID_SOURCE_MAP',
        message: 'The uploaded file is not a valid version 3 source map.',
      });
    }
  });
}
