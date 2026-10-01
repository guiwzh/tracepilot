/** 上传到哪里：服务端地址、项目和版本。 */
export interface UploadTarget {
  /** 服务端地址，例如 http://localhost:4318。 */
  url: string;
  projectId: string;
  /** 版本号，与 SDK 初始化时的 release 相同。 */
  release: string;
}

/** 上传的结果：份数，以及版本已经存在、却记着另一个提交（或没有提交）时的提示。 */
export interface UploadResult {
  uploaded: number;
  warning?: string;
}

/** 一份待上传的 map。 */
export interface MapFile {
  /** 它对应的产物文件名（不含目录），服务端按「版本 + 文件名」查找时用它。 */
  minifiedFile: string;
  debugId: string;
  content: string;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    // 把服务端的错误原文带出来：400 时它说明了 map 哪里不合格。
    throw new Error(
      `${init?.method ?? 'GET'} ${url} → ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

/**
 * 找到版本对应的 Release；还没有就创建，并记下构建所在的提交（排障时据此读这个版本的代码、找嫌疑提交）。
 * SDK 上报时服务端也会按版本号自动创建版本（没有提交号），先到先得；已经存在时不改它，只给出提示。
 */
async function ensureRelease(
  target: UploadTarget,
  commitSha: string | null,
): Promise<{ id: string; warning?: string }> {
  const base = `${target.url.replace(/\/$/, '')}/api/v1/projects/${encodeURIComponent(target.projectId)}/releases`;
  const { items } = await call<{
    items: Array<{ id: string; version: string; commitSha: string | null }>;
  }>(base);
  const existing = items.find((item) => item.version === target.release);
  if (existing) {
    const mismatch = commitSha && existing.commitSha !== commitSha;
    return {
      id: existing.id,
      ...(mismatch
        ? {
            warning: `release ${target.release} already exists with commit ${existing.commitSha ?? 'none'}, not ${commitSha.slice(0, 12)}`,
          }
        : {}),
    };
  }
  const created = await call<{ id: string }>(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: target.release, ...(commitSha ? { commitSha } : {}) }),
  });
  return { id: created.id };
}

/**
 * 把 map 逐个上传到版本下，返回上传的份数。逐个而不是并发：一次构建只有几个到几十个 chunk，
 * 服务端每收到一份都要完整校验、回填历史事件，并发上传只会让它们互相抢 CPU。
 */
export async function uploadSourceMaps(
  target: UploadTarget,
  files: MapFile[],
  commitSha: string | null = null,
): Promise<UploadResult> {
  if (files.length === 0) return { uploaded: 0 };
  const { id: releaseId, warning } = await ensureRelease(target, commitSha);
  const endpoint = `${target.url.replace(/\/$/, '')}/api/v1/releases/${encodeURIComponent(releaseId)}/source-maps`;
  for (const file of files) {
    const form = new FormData();
    form.append('minifiedFile', file.minifiedFile);
    form.append(
      'file',
      new Blob([file.content], { type: 'application/json' }),
      `${file.minifiedFile}.map`,
    );
    await call(endpoint, { method: 'POST', body: form });
  }
  return { uploaded: files.length, ...(warning ? { warning } : {}) };
}
