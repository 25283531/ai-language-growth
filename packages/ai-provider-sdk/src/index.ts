/**
 * @alg/ai-provider-sdk —— 统一 LLM / TTS / ASR / 发音评估供应商协议
 *
 * 教学逻辑永远不直接调用供应商，只通过本包暴露的协议（D-012 / 约束二）。
 */
export * from './protocol';
export * from './http';
export * from './signed-tts';
export * from './provider-presets';
export * from './vendor-pronunciation';
export * from './vendor-speech';
export * from './vendor-tencent-cloud';
export * from './mock';
export * from './config';
