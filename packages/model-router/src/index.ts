/**
 * @alg/model-router —— AI Model Router
 *
 * 只负责选模型与升级判定，不负责调用（D-012）。
 * 业务代码自始只面向 Router 接口，M2 的完整路由是接口背后的实现升级。
 */
export * from './router';
export * from './method-ladder';
