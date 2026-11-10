/**
 * @tianji/shared —— 前后端同源共享层
 *
 * 该包不依赖任何第三方运行时，同时被 NestJS（CommonJS）与 Vite（ESM/CJS 互操作）引用。
 * 所有跨端常量、枚举、错误码、档号模板逻辑、DTO 契约均以此为准，避免前后端定义漂移。
 */
export * from './enums';
export * from './errors';
export * from './danghao';
export * from './dto';
export * from './permission';
export * from './params';
export * from './permission-mutations';
export * from './chunker';
