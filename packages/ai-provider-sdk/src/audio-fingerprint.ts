/**
 * TTS 音频文件指纹（4 个 TTS 适配器共用的唯一实现）。
 *
 * 背景：落盘文件名是「请求参数指纹」，不是音频字节哈希。旧实现只取
 * text + speed + model + voice，属于全局去重 —— 不同课程、同一段文本会
 * 写出并复用同一个文件；更糟的是切换音色/模型版本时 existsSync 会跳过
 * 写盘、静默返回旧音频。
 *
 * 现在把指纹扩展到「课程级作用域」：
 *   - cacheScope(scope/topicId/contentId/contentVersion) 决定这份语音属于哪门课、
 *     哪个内容版本：不同课程同文本必得不同指纹；
 *   - 同一课程的不同用户、不同时间得到的 scope 完全相同（不含 userId/时间戳/
 *     SessionId），因此复用同一份课程语音资源；
 *   - voiceProfileVersion / modelFamily 升版本时自然生成新文件名，旧音频不再被
 *     existsSync 静默命中；
 *   - voiceStyle / pronunciationMode 补齐为声学维度。
 *
 * 「纯函数」边界：computeAudioFingerprint 是纯的（输入确定则输出确定）；
 * audioFingerprint 只做归一化并把环境相关的 voiceProfileVersion 解析出来后
 * 交给纯函数，4 个适配器统一调用它，避免 4 份实现漂移。
 */
import { createHash } from 'node:crypto';

/** 完全缺省时的稳定默认作用域，保证缺字段也得到确定指纹、不抛错。 */
export const UNSCOPED_CACHE_SCOPE = 'private:unscoped';
/** 音色配置版本的缺省值，与 gateway 缓存键口径一致。 */
export const DEFAULT_VOICE_PROFILE_VERSION = '1';
/** 指纹算法版本盐：将来调整维度结构时可强制全量失效旧文件。 */
const FINGERPRINT_VERSION = 'audio-fp-v2';

/**
 * 课程级缓存作用域。字段用 unknown 是为了不与并行扩展中的 shared-contracts
 * 强绑定：字段落地前后、以及不同调用方（对象/平铺/标量）都能稳定读取。
 */
export interface AudioCacheScope {
  scope?: unknown;
  topicId?: unknown;
  contentId?: unknown;
  contentVersion?: unknown;
  /** PRIVATE_DYNAMIC 的资产归属；PUBLIC_CURRICULUM / PRONUNCIATION 必须忽略。 */
  learnerId?: unknown;
}

/** 适配器持有的 TtsRequest 宽松视图（不 import 强类型，避免与并行改动冲突）。 */
export interface AudioFingerprintRequest {
  text: string;
  voice?: {
    voiceStyle?: unknown;
    pronunciationMode?: unknown;
    [key: string]: unknown;
  } | null;
  voiceIdentity?: unknown;
  /** 首选：结构化作用域对象 */
  cacheScope?: AudioCacheScope | string | number | null;
  /** 兜底：平铺在 request 顶层的作用域字段 */
  scope?: unknown;
  topicId?: unknown;
  contentId?: unknown;
  contentVersion?: unknown;
  /** 音色配置版本（升版本必须换文件） */
  voiceProfileVersion?: unknown;
  /** 模型族标识 */
  modelFamily?: unknown;
  [key: string]: unknown;
}

/** 适配器特有的、会影响实际声学输出的维度。 */
export interface AudioFingerprintAdapterInput {
  /** 归一化后写入请求体的最终语速（各协议口径不同，由适配器给最终值） */
  speed: unknown;
  /** 最终音色标识（options.voice / voiceIdentity 覆盖后的值） */
  voice: unknown;
  /** 模型别名 */
  modelAlias: unknown;
  /** 协议/动作/服务/区域/编码/采样率/extraBody 等适配器特有维度 */
  extra?: ReadonlyArray<unknown>;
}

/** 把任意值归一化为稳定字符串；对象走 JSON.stringify，空值收敛为空串。 */
function stableValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/** 解析音色配置版本：request 显式值 > 环境变量 > 稳定默认。 */
export function resolveVoiceProfileVersion(
  request: AudioFingerprintRequest,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return stableValue(request.voiceProfileVersion)
    || stableValue(env.TTS_VOICE_PROFILE_VERSION)
    || DEFAULT_VOICE_PROFILE_VERSION;
}

/**
 * 归一化缓存作用域：兼容结构化对象、标量字符串、平铺字段三种注入方式。
 * 完全缺省返回 UNSCOPED_CACHE_SCOPE（稳定默认，不抛错）。
 *
 * 注意：这里只纳入课程维度，绝不纳入 learnerId / 时间戳 / SessionId，
 * 否则「同一课程不同用户/时间复用」的语义会被破坏。
 */
export function normalizeCacheScope(request: AudioFingerprintRequest): string {
  const raw = request.cacheScope;
  if (raw && typeof raw === 'object') {
    const scope = stableValue(raw.scope ?? request.scope);
    const parts = {
      scope,
      topicId: stableValue(raw.topicId ?? request.topicId),
      contentId: stableValue(raw.contentId ?? request.contentId),
      contentVersion: stableValue(raw.contentVersion ?? request.contentVersion),
      // PRIVATE_DYNAMIC 是「某个孩子的动态话语」：物理文件也必须按归属区分，
      // 否则两个孩子的私人音频会共用一个 24-hex 文件名与同一条 media_assets
      // 记录（后写覆盖 owner），媒体下载的归属校验就失去意义。
      // PUBLIC_CURRICULUM / PRONUNCIATION 刻意忽略 learnerId，保证跨用户复用。
      ...(scope === 'PRIVATE_DYNAMIC' ? { owner: stableValue(raw.learnerId) } : {}),
    };
    if (Object.values(parts).some((value) => value !== '')) return JSON.stringify(parts);
  }
  if (typeof raw === 'string' || typeof raw === 'number') {
    const scalar = stableValue(raw);
    if (scalar) return scalar;
  }
  const flat = [
    stableValue(request.scope),
    stableValue(request.topicId),
    stableValue(request.contentId),
    stableValue(request.contentVersion),
  ];
  if (flat.some((value) => value !== '')) return flat.join('|');
  return UNSCOPED_CACHE_SCOPE;
}

/** 纯函数：把一组归一化维度压成 24 位 hex 文件名指纹。 */
export function computeAudioFingerprint(parts: ReadonlyArray<unknown>): string {
  return createHash('sha256')
    .update(parts.map(stableValue).join('|'))
    .digest('hex')
    .slice(0, 24);
}

/**
 * 4 个 TTS 适配器统一入口：集中做所有归一化，保证零实现漂移。
 *
 * 声学维度：文本、最终语速、音色、模型、voiceStyle、pronunciationMode、
 * 课程作用域、音色版本、模型族，外加适配器特有维度。
 * 刻意不纳入 pauseAfterSentenceMs：它不写入 TTS 请求体、客户端也不读取，
 * 只会制造「声学相同但文件名不同」的重复计费与 audioRef 漂移。
 */
export function audioFingerprint(
  request: AudioFingerprintRequest,
  adapter: AudioFingerprintAdapterInput,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const voice = request.voice ?? {};
  return computeAudioFingerprint([
    FINGERPRINT_VERSION,
    request.text,
    adapter.speed,
    adapter.voice,
    adapter.modelAlias,
    voice.voiceStyle,
    voice.pronunciationMode,
    normalizeCacheScope(request),
    resolveVoiceProfileVersion(request, env),
    request.modelFamily,
    ...(adapter.extra ?? []),
  ]);
}
