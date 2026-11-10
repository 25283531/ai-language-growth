/**
 * 统一契约出口。
 *
 * 所有跨端共享的结构都从这里导出：后端、Web、Android 客户端依赖同一份定义，
 * 保证「教学逻辑与客户端分离」的契约层只有一处（D-024 约束一）。
 */
export * from './learner';
export * from './evidence';
export * from './teaching';
export * from './router';
export * from './skill-node';
export * from './api';
export * from './cefr';
