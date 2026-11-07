/**
 * 全局配置中心 —— 所有环境变量集中读取、校验、赋予默认值。
 *
 * 约定（架构 §2/§8）：
 *  - 配置全部外置化，禁止在业务代码里直接读 process.env；
 *  - TTL 与数值型配置统一在此转换，避免各处重复 parse；
 *  - 启动时对关键项做一次校验，缺失时给出清晰中文报错。
 */

export type AppConfig = ReturnType<typeof loadConfiguration>;

/** 将 '2h' / '14d' / '30m' / '90s' / 纯数字（秒）转换为秒 */
export function parseTtlToSeconds(ttl: string | number | undefined, fallback = 3600): number {
  if (ttl === undefined || ttl === null || ttl === '') return fallback;
  if (typeof ttl === 'number') return Number.isFinite(ttl) ? ttl : fallback;
  const raw = ttl.trim();
  const match = /^(\d+)\s*([smhd]?)$/i.exec(raw);
  if (!match) return fallback;
  const value = Number.parseInt(match[1], 10);
  const unit = (match[2] || 's').toLowerCase();
  const factor = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return value * factor;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}

/** 读取配置（nest ConfigModule 的 load 函数） */
export function loadConfiguration(): {
  env: string;
  api: { port: number; prefix: string; corsOrigins: string[]; bodyLimit: string };
  db: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    logging: boolean;
    poolSize: number;
  };
  es: { node: string; username: string; password: string; index: string };
  minio: {
    endPoint: string;
    port: number;
    useSSL: boolean;
    accessKey: string;
    secretKey: string;
    buckets: { original: string; preview: string; thumb: string; backup: string };
    presignExpires: number;
  };
  redis: { host: string; port: number; password: string; db: number };
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
  };
  security: {
    bcryptRounds: number;
    pwdMinLength: number;
    pwdExpireDays: number;
    pwdMaxFailed: number;
    pwdLockMinutes: number;
  };
  features: { previewWatermark: boolean; downloadEnabled: boolean };
  queue: { extract: string; extractConcurrency: number };
  backup: { dir: string; retentionDays: number; cron: string };
} {
  const env = str(process.env.NODE_ENV, 'development');
  return {
    env,
    api: {
      port: int(process.env.API_PORT, 3000),
      prefix: str(process.env.API_PREFIX, 'api'),
      corsOrigins: str(process.env.CORS_ORIGINS, 'http://localhost:5173,http://localhost:8080')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      bodyLimit: str(process.env.API_BODY_LIMIT, '10mb'),
    },
    db: {
      host: str(process.env.POSTGRES_HOST, '127.0.0.1'),
      port: int(process.env.POSTGRES_PORT, 5432),
      username: str(process.env.POSTGRES_USER, 'tianji'),
      password: str(process.env.POSTGRES_PASSWORD, 'tianji_pwd_change_me'),
      database: str(process.env.POSTGRES_DB, 'tianji_archive'),
      logging: bool(process.env.DB_LOGGING, false),
      poolSize: int(process.env.DB_POOL_SIZE, 20),
    },
    es: {
      node: str(process.env.ES_NODE, 'http://127.0.0.1:9200'),
      username: str(process.env.ES_USERNAME, ''),
      password: str(process.env.ES_PASSWORD, ''),
      index: str(process.env.ES_INDEX, 'archive_items'),
    },
    minio: {
      endPoint: str(process.env.MINIO_ENDPOINT, '127.0.0.1'),
      port: int(process.env.MINIO_PORT, 9000),
      useSSL: bool(process.env.MINIO_USE_SSL, false),
      accessKey: str(process.env.MINIO_ACCESS_KEY, 'tianji_minio'),
      secretKey: str(process.env.MINIO_SECRET_KEY, 'tianji_minio_change_me'),
      buckets: {
        original: str(process.env.MINIO_BUCKET_ORIGINAL, 'archive-original'),
        preview: str(process.env.MINIO_BUCKET_PREVIEW, 'archive-preview'),
        thumb: str(process.env.MINIO_BUCKET_THUMB, 'archive-thumb'),
        backup: str(process.env.MINIO_BUCKET_BACKUP, 'archive-backup'),
      },
      presignExpires: int(process.env.MINIO_PRESIGN_EXPIRES, 3600),
    },
    redis: {
      host: str(process.env.REDIS_HOST, '127.0.0.1'),
      port: int(process.env.REDIS_PORT, 6379),
      password: str(process.env.REDIS_PASSWORD, ''),
      db: int(process.env.REDIS_DB, 0),
    },
    jwt: {
      accessSecret: str(process.env.JWT_ACCESS_SECRET, 'dev_access_secret_change_me_32chars'),
      refreshSecret: str(process.env.JWT_REFRESH_SECRET, 'dev_refresh_secret_change_me_32chars'),
      accessTtlSeconds: parseTtlToSeconds(process.env.JWT_ACCESS_TTL, 7200),
      refreshTtlSeconds: parseTtlToSeconds(process.env.JWT_REFRESH_TTL, 1209600),
    },
    security: {
      bcryptRounds: int(process.env.BCRYPT_ROUNDS, 10),
      pwdMinLength: int(process.env.PWD_MIN_LENGTH, 10),
      pwdExpireDays: int(process.env.PWD_EXPIRE_DAYS, 90),
      pwdMaxFailed: int(process.env.PWD_MAX_FAILED, 5),
      pwdLockMinutes: int(process.env.PWD_LOCK_MINUTES, 30),
    },
    features: {
      previewWatermark: bool(process.env.PREVIEW_WATERMARK, true),
      downloadEnabled: bool(process.env.DOWNLOAD_ENABLED, false),
    },
    queue: {
      extract: str(process.env.EXTRACT_QUEUE_NAME, 'archive-extract'),
      extractConcurrency: int(process.env.EXTRACT_CONCURRENCY, 4),
    },
    backup: {
      dir: str(process.env.BACKUP_DIR, '/backup'),
      retentionDays: int(process.env.BACKUP_RETENTION_DAYS, 30),
      cron: str(process.env.BACKUP_CRON, '0 2 * * *'),
    },
  };
}

/**
 * 生产环境关键配置校验：缺失/默认值直接告警，便于部署期发现问题。
 * @returns 告警列表（空数组表示无问题）
 */
export function validateProductionConfig(config: AppConfig): string[] {
  const warnings: string[] = [];
  if (config.env !== 'production') return warnings;
  const insecure = ['change_me', 'dev_access_secret', 'dev_refresh_secret'];
  const check = (name: string, value: string): void => {
    if (insecure.some((k) => value.includes(k))) {
      warnings.push(`${name} 仍使用默认值，请在生产环境替换`);
    }
  };
  check('JWT_ACCESS_SECRET', config.jwt.accessSecret);
  check('JWT_REFRESH_SECRET', config.jwt.refreshSecret);
  check('POSTGRES_PASSWORD', config.db.password);
  check('MINIO_SECRET_KEY', config.minio.secretKey);
  if (!config.features.downloadEnabled) {
    warnings.push('DOWNLOAD_ENABLED=false：下载功能已关闭，仅允许在线预览（符合默认策略）');
  }
  return warnings;
}
