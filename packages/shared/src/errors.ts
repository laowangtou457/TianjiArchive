/**
 * 统一错误码表（架构 §11）+ 业务异常类。
 *
 * 码段划分：
 *   0      成功
 *   1xxx   通用（参数/认证/权限/资源不存在/频率限制）
 *   2xxx   档号（冲突/规则缺失/无锁/模板非法）
 *   3xxx   借阅（状态非法/逾期上限/重复申请）
 *   4xxx   文件（哈希不符/类型不支持/超限/上传未完成）
 *   5xxx   系统（内部错误/依赖不可用/备份/迁移）
 *   9xxx   预留（KB/RAG）
 */

export interface ErrorCodeDef {
  /** 业务错误码 */
  code: number;
  /** 建议 HTTP 状态码 */
  httpStatus: number;
  /** 默认中文提示 */
  message: string;
}

export const ErrorCode: Readonly<Record<string, ErrorCodeDef>> = {
  // ------------------------------------------------------------ 1xxx 通用
  OK: { code: 0, httpStatus: 200, message: '成功' },
  BAD_REQUEST: { code: 1001, httpStatus: 400, message: '请求参数不合法' },
  UNAUTHORIZED: { code: 1002, httpStatus: 401, message: '未登录或登录已过期' },
  FORBIDDEN: { code: 1003, httpStatus: 403, message: '无权限执行该操作' },
  NOT_FOUND: { code: 1004, httpStatus: 404, message: '资源不存在' },
  CONFLICT: { code: 1005, httpStatus: 409, message: '资源冲突' },
  TOO_MANY_REQUESTS: { code: 1006, httpStatus: 429, message: '操作过于频繁，请稍后再试' },
  VALIDATION_FAILED: { code: 1007, httpStatus: 400, message: '数据校验未通过' },
  TOKEN_INVALID: { code: 1008, httpStatus: 401, message: '令牌无效' },
  TOKEN_EXPIRED: { code: 1009, httpStatus: 401, message: '令牌已过期' },
  ACCOUNT_LOCKED: { code: 1010, httpStatus: 423, message: '账号已锁定，请联系管理员' },
  ACCOUNT_DISABLED: { code: 1011, httpStatus: 403, message: '账号已停用' },
  BAD_CREDENTIALS: { code: 1012, httpStatus: 401, message: '用户名或密码错误' },
  PASSWORD_POLICY: { code: 1013, httpStatus: 400, message: '密码不符合安全策略' },
  PASSWORD_EXPIRED: { code: 1014, httpStatus: 403, message: '密码已过期，请修改后登录' },
  IDEMPOTENT_REPLAY: { code: 1015, httpStatus: 200, message: '重复请求（幂等返回）' },

  // ------------------------------------------------------------ 2xxx 档号
  ARCHIVE_NO_CONFLICT: { code: 2001, httpStatus: 409, message: '档号冲突，请重试' },
  RULE_NOT_FOUND: { code: 2002, httpStatus: 400, message: '未找到适用的档号规则' },
  NO_LOCKED: { code: 2003, httpStatus: 409, message: '档号序列锁定失败' },
  DANGHAO_IMMUTABLE: { code: 2004, httpStatus: 400, message: '档号入库后不可修改，请使用作废重编' },
  RULE_TEMPLATE_INVALID: { code: 2005, httpStatus: 400, message: '档号模板定义非法' },
  SEQUENCE_EXHAUSTED: { code: 2006, httpStatus: 500, message: '档号序列分配失败（已重试 3 次）' },
  FONDS_DISABLED: { code: 2007, httpStatus: 400, message: '全宗已停用，不允许新增档案' },

  // ------------------------------------------------------------ 3xxx 借阅
  BORROW_INVALID_STATE: { code: 3001, httpStatus: 409, message: '借阅单状态不允许该操作' },
  BORROW_OVERDUE_LIMIT: { code: 3002, httpStatus: 400, message: '存在逾期未还，暂不可再借' },
  BORROW_DUPLICATE: { code: 3003, httpStatus: 409, message: '该档案已有进行中的借阅申请' },
  BORROW_RENEW_LIMIT: { code: 3004, httpStatus: 400, message: '续借次数已达上限' },
  BORROW_NOT_OWNER: { code: 3005, httpStatus: 403, message: '只能操作本人的借阅单' },

  // ------------------------------------------------------------ 4xxx 文件
  FILE_HASH_MISMATCH: { code: 4001, httpStatus: 400, message: '文件哈希校验不一致' },
  FILE_UNSUPPORTED_TYPE: { code: 4002, httpStatus: 400, message: '不支持的文件类型' },
  FILE_TOO_LARGE: { code: 4003, httpStatus: 413, message: '文件超过大小上限（2GB）' },
  FILE_UPLOAD_INCOMPLETE: { code: 4004, httpStatus: 400, message: '分片上传未完成' },
  FILE_NOT_FOUND: { code: 4005, httpStatus: 404, message: '电子文件不存在' },
  PREVIEW_UNSUPPORTED: { code: 4006, httpStatus: 415, message: '该格式暂不支持在线预览，请下载查看' },
  DOWNLOAD_DISABLED: { code: 4007, httpStatus: 403, message: '系统已关闭下载，请使用在线预览' },
  OBJECT_STORE_UNAVAILABLE: { code: 4008, httpStatus: 503, message: '对象存储不可用' },

  // ------------------------------------------------------------ 5xxx 系统
  INTERNAL_ERROR: { code: 5000, httpStatus: 500, message: '系统内部错误' },
  DEPENDENCY_UNAVAILABLE: { code: 5001, httpStatus: 503, message: '依赖服务不可用' },
  SEARCH_ENGINE_ERROR: { code: 5002, httpStatus: 503, message: '检索引擎异常' },
  BACKUP_FAILED: { code: 5003, httpStatus: 500, message: '备份执行失败' },
  RESTORE_FAILED: { code: 5004, httpStatus: 500, message: '恢复执行失败' },
  MIGRATION_RUNNING: { code: 5005, httpStatus: 409, message: '迁移任务正在执行' },
  NOT_IMPLEMENTED: { code: 5006, httpStatus: 501, message: '该能力尚未实现（预留接口）' },
  DICT_IN_USE: { code: 5007, httpStatus: 409, message: '字典项已被引用，禁止删除' },
  RECYCLE_EXPIRED: { code: 5008, httpStatus: 410, message: '回收站数据已过期，无法还原' },

  // ------------------------------------------------------------ 9xxx 知识库预留
  KB_NOT_ENABLED: { code: 9001, httpStatus: 501, message: '知识库能力未启用（P2 预留）' },
  KB_NO_EMBEDDING_PROVIDER: { code: 9002, httpStatus: 501, message: '未配置向量化提供方' },
};

/** 按错误码数字查找定义 */
export function findErrorDef(code: number): ErrorCodeDef | undefined {
  return Object.values(ErrorCode).find((d) => d.code === code);
}

/** 统一响应体 */
export interface ApiResponse<T = unknown> {
  code: number;
  data: T;
  message: string;
  /** 服务端时间戳（便于前端排查） */
  timestamp?: string;
  /** 请求追踪 ID */
  traceId?: string;
}

/** 构造成功响应 */
export function ok<T>(data: T, message = '成功'): ApiResponse<T> {
  return { code: 0, data, message };
}

/** 构造失败响应 */
export function fail(code: number, message?: string): ApiResponse<null> {
  const def = findErrorDef(code);
  return { code, data: null, message: message ?? def?.message ?? '未知错误' };
}

/**
 * 业务异常：由 HttpExceptionFilter 统一转换为 {code,data,message}。
 * 服务层抛出该异常即可携带业务错误码。
 */
export class BizException extends Error {
  public readonly code: number;
  public readonly httpStatus: number;
  public readonly details: unknown;

  constructor(codeOrDef: number | ErrorCodeDef, message?: string, details?: unknown) {
    const def: ErrorCodeDef =
      typeof codeOrDef === 'number'
        ? findErrorDef(codeOrDef) ?? ErrorCode.INTERNAL_ERROR
        : codeOrDef;
    super(message ?? def.message);
    this.name = 'BizException';
    this.code = def.code;
    this.httpStatus = def.httpStatus;
    this.details = details ?? null;
  }

  static badRequest(message?: string, details?: unknown): BizException {
    return new BizException(ErrorCode.BAD_REQUEST, message, details);
  }

  static forbidden(message?: string): BizException {
    return new BizException(ErrorCode.FORBIDDEN, message);
  }

  static notFound(message?: string): BizException {
    return new BizException(ErrorCode.NOT_FOUND, message);
  }

  static unauthorized(message?: string): BizException {
    return new BizException(ErrorCode.UNAUTHORIZED, message);
  }
}
