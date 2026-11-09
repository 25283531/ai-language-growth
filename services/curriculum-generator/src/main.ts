import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import AdmZip from 'adm-zip';

const port = Number(process.env.PORT || 3200);
const dataDir = process.env.CURRICULUM_PACKAGE_DIR || '/app/data/packages';
const backendUrl = process.env.BACKEND_INTERNAL_URL || 'http://backend:3000';
const serviceToken = process.env.CURRICULUM_GENERATOR_TOKEN || '';

type GenerateInput = {
  description?: string;
  words?: string[] | string;
  level?: string;
  title?: string;
  textbook?: { publisher?: string; publicationYear?: number; grade?: string; edition?: string };
  skillNodes?: Array<{ id: string; code: string; name: string; objective: string }>;
};

const stages = [
  '启蒙与适应',
  '听力理解与语言反应',
  '声音辨别与发音形成',
  '词汇理解与主动表达',
  '短语与完整句子',
  '对话与语言组织',
  '自主日常交流',
];

function send(res: ServerResponse, status: number, body: unknown, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(contentType.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function body(req: IncomingMessage): Promise<GenerateInput> {
  let value = '';
  for await (const chunk of req) value += chunk;
  return JSON.parse(value || '{}') as GenerateInput;
}

function wordsOf(input: GenerateInput): string[] {
  const raw = Array.isArray(input.words) ? input.words : String(input.words || '').split(/\r?\n|,|，/);
  return [...new Set(raw.map((word) => word.trim()).filter(Boolean))].slice(0, 200);
}

function jsonFromModel(content: string): Record<string, unknown> | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || content;
  try {
    const parsed = JSON.parse(fenced.trim()) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = -1, b = -1] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  const normalized = address.toLowerCase();
  return normalized !== '::' && normalized !== '::1' &&
    !normalized.startsWith('fc') && !normalized.startsWith('fd') &&
    !normalized.startsWith('fe8') && !normalized.startsWith('fe9') &&
    !normalized.startsWith('fea') && !normalized.startsWith('feb');
}

async function fetchPublicImage(source: string): Promise<{ bytes: Buffer; type: string } | null> {
  let current: URL;
  try { current = new URL(source); } catch { return null; }
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (current.protocol !== 'https:' || current.username || current.password) return null;
    try {
      const addresses = await lookup(current.hostname, { all: true });
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) return null;
    } catch { return null; }
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) return null;
    const type = ((response.headers.get('content-type') || '').split(';')[0] || '').trim().toLowerCase();
    if (!type.startsWith('image/')) return null;
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > 4 * 1024 * 1024) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) return null;
    return { bytes, type };
  }
  return null;
}

async function callModel(role: 'small' | 'main', system: string, prompt: string): Promise<string> {
  if (!serviceToken) throw new Error('课程生成内部凭据未配置');
  const response = await fetch(`${backendUrl.replace(/\/+$/, '')}/api/v1/admin/curriculum/internal/model`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-curriculum-token': serviceToken },
    body: JSON.stringify({ role, system, prompt }),
  });
  if (!response.ok) throw new Error(`模型请求失败 HTTP ${response.status}`);
  const payload = await response.json() as { content?: string };
  const content = payload.content;
  if (!content) throw new Error('模型未返回内容');
  return content;
}

async function generate(input: GenerateInput): Promise<{ packageId: string; title: string; level: string; downloadPath: string }> {
  const words = wordsOf(input);
  if (!words.length) throw new Error('至少提供一个学习词汇');
  const level = input.level || 'pre-A1';
  const title = input.title || `${level} 词汇课程`;
  let enrichment: Record<string, unknown> = { words: words.map((word) => ({ word })) };
  try {
    const content = await callModel(
      'small',
      '你是儿童英语课程素材整理器。只输出 JSON 对象，格式为 {"words":[{"word":"","phonetic":"","meaningZh":"","syllables":[],"phrases":[],"exampleSentences":[],"difficultPhonemes":[]}] }。',
      JSON.stringify({ level, words, description: input.description || '' }),
    );
    enrichment = jsonFromModel(content) || enrichment;
  } catch {
    // 小模型不可用时由主模型直接完成全部生成。
  }
  const content = await callModel(
    'main',
    '你是 6-9 岁儿童英语课程总编辑。只输出 JSON，不要 markdown。生成可人工审核、可验证的课程包。每个词包含 IPA 音标、中文释义、音节、发音难点、常见短语和儿童短句。课程必须覆盖七阶段，每个阶段至少一个 activity，activity 要包含 stage、taskType、scenario、targetWords、teacherUtteranceZh、demonstrationText、skillNodeIds、requiresAsr、requiresPronunciationAssessment、difficulty 和 assessment；assessment 的固定答案用 acceptedTexts、acceptedImageIds 或 requiredPhrases 表达。skillNodeIds 必须来自输入节点。图片只填写可公开访问且授权明确的 URL、license、attribution，不能编造。',
    JSON.stringify({
      title,
      level,
      description: input.description || '',
      textbook: input.textbook || null,
      skillNodes: input.skillNodes || [],
      sevenStages: stages,
      enrichedVocabulary: enrichment,
      output: 'title,level,objectives,vocabulary,activities,images',
    }),
  );
  const generated = jsonFromModel(content) || {
    title,
    level,
    objectives: [`掌握 ${words.length} 个目标词汇并能在生活场景中使用`],
    vocabulary: enrichment.words,
    activities: stages.map((stage, index) => ({
      id: `stage-${index + 1}`,
      stage,
      taskType: index < 2 ? 'listening_comprehension' : index < 4 ? 'word_mimicry' : 'situational_dialogue',
      teacherPrompt: `完成${stage}活动`,
      targetWords: words.slice(0, 12),
      assessment: { acceptedTexts: words.slice(0, 3), requiredPhrases: [], openResponse: false },
    })),
    images: [],
  };
  const packageId = randomUUID();
  await mkdir(dataDir, { recursive: true });
  const json = {
    schemaVersion: 1,
    packageId,
    title,
    source: 'curriculum-generator',
    generatedAt: new Date().toISOString(),
    level,
    textbook: input.textbook || null,
    description: input.description || '',
    ...generated,
  };
  const zip = new AdmZip();
  const images = Array.isArray(generated.images) ? generated.images as Array<Record<string, unknown>> : [];
  const vocabulary = Array.isArray(generated.vocabulary) ? generated.vocabulary as Array<Record<string, unknown>> : [];
  const imageCandidates = [
    ...images,
    ...vocabulary.flatMap((entry) => entry.image && typeof entry.image === 'object' ? [entry.image as Record<string, unknown>] : []),
  ].slice(0, 12);
  const downloaded = new Map<string, string>();
  let imageIndex = 0;
  for (const image of imageCandidates) {
    const url = typeof image.url === 'string' ? image.url : '';
    if (!url || downloaded.has(url)) continue;
    const asset = await fetchPublicImage(url).catch(() => null);
    if (!asset) {
      image.downloadStatus = 'unavailable_or_unsafe';
      continue;
    }
    imageIndex += 1;
    const extension = asset.type === 'image/png' ? 'png' : asset.type === 'image/webp' ? 'webp' : asset.type === 'image/gif' ? 'gif' : 'jpg';
    const localPath = `assets/images/${String(imageIndex).padStart(2, '0')}.${extension}`;
    zip.addFile(localPath, asset.bytes);
    image.localPath = localPath;
    image.downloadStatus = 'downloaded';
    downloaded.set(url, localPath);
  }
  zip.addFile('curriculum-package.json', Buffer.from(JSON.stringify(json, null, 2), 'utf8'));
  zip.addFile('README.txt', Buffer.from('课程包由独立课程生产服务生成，导入后台后须人工审核再发布。', 'utf8'));
  const filePath = join(dataDir, `${packageId}.zip`);
  await writeFile(filePath, zip.toBuffer());
  return { packageId, title, level, downloadPath: `/packages/${packageId}/download` };
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, service: 'curriculum-generator' });
    if (req.method === 'POST' && req.url === '/generate') {
      if (!serviceToken || req.headers['x-curriculum-token'] !== serviceToken) {
        return send(res, 401, { message: 'Unauthorized' });
      }
      return send(res, 201, await generate(await body(req)));
    }
    const match = req.url?.match(/^\/packages\/([^/]+)\/download$/);
    if (req.method === 'GET' && match) {
      if (!serviceToken || req.headers['x-curriculum-token'] !== serviceToken) {
        return send(res, 401, { message: 'Unauthorized' });
      }
      const file = await readFile(join(dataDir, `${match[1]}.zip`));
      return send(res, 200, file, 'application/zip');
    }
    return send(res, 404, { message: 'Not found' });
  } catch (error) {
    return send(res, 400, { message: error instanceof Error ? error.message : '课程生成失败' });
  }
});

server.listen(port, '0.0.0.0', () => console.log(`curriculum-generator listening on ${port}`));
