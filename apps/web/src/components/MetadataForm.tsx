import { useMemo, useState, type ReactElement } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Chip,
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  TextField,
} from '@mui/material';
import {
  OpenFlag,
  OPEN_FLAG_LABELS,
  RETENTION_LABELS,
  RETENTION_VALUES,
  SECURITY_LEVEL_LABELS,
  SECURITY_LEVEL_VALUES,
  type ItemStatus,
  type MetadataFieldDef,
  type Retention,
  type SecurityLevel,
} from '@tianji/shared';

/** 表单值（键为字段 key，值为原始类型） */
export type FormValues = Record<string, string | number | boolean | string[] | null>;

/** 组件属性 */
export interface MetadataFormProps {
  /** 门类动态字段定义（来自 category.fieldSchema，按 level 过滤后） */
  fields: MetadataFieldDef[];
  /** 当前值 */
  values: FormValues;
  /** 值变更 */
  onChange: (key: string, value: FormValues[string]) => void;
  /** 校验错误（key → 中文提示） */
  errors?: Record<string, string>;
  /** 是否只读（已归档/已作废时全部只读，档号恒只读） */
  readOnly?: boolean;
  /** 条目状态（用于展示档号不可改提示） */
  status?: ItemStatus;
  /** 档号（只读展示，核心字段 readonly=true 时渲染） */
  danghao?: string;
  /** 列排列数 */
  columns?: 1 | 2 | 3;
}

/**
 * 动态著录表单（F-03/F-04 的核心交互）。
 *
 * 合规约束（PRD §6）：
 *   1) 核心字段（core=true）永不可裁剪、不可隐藏 —— 即使后端未下发也会补渲染；
 *   2) 档号（key='danghao'）恒只读 —— 档号入库后不可改，唯一通道是「作废重编」；
 *   3) required=true 的字段前端标星并在提交前阻断。
 */
export function MetadataForm(props: MetadataFormProps): ReactElement {
  const { fields, values, onChange, errors = {}, readOnly = false, status, danghao, columns = 2 } = props;

  /** 保证核心字段存在（后端已合并，前端再做一次兜底） */
  const effectiveFields = useMemo(() => {
    const map = new Map<string, MetadataFieldDef>();
    for (const f of fields) map.set(f.key, f);
    const withDanghao = map.get('danghao');
    if (!withDanghao) {
      map.set('danghao', {
        key: 'danghao',
        label: '档号',
        type: 'string',
        required: true,
        core: true,
        readonly: true,
        level: 'BOTH',
        order: 0,
      });
    }
    return [...map.values()].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  }, [fields]);

  const gridStyle = {
    display: 'grid',
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gap: '10px 16px',
  } as const;

  return (
    <Box>
      {status === 'ARCHIVED' && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          该档案已归档：内容只读；档号不可修改，如需更正请使用「作废重编」。
        </Alert>
      )}
      {status === 'VOID' && (
        <Alert severity="error" sx={{ mb: 1.5 }}>
          该档案已作废，仅可查看。
        </Alert>
      )}

      <div style={gridStyle}>
        {effectiveFields.map((field) => {
          const value = field.key === 'danghao' ? (danghao ?? values[field.key] ?? '') : values[field.key];
          const fieldReadOnly = readOnly || field.readonly === true || status === 'ARCHIVED' || status === 'VOID';
          const err = errors[field.key];
          const full = field.type === 'text' || field.key === 'note' || field.key === 'title';

          return (
            <Box key={field.key} sx={full ? { gridColumn: '1 / -1' } : undefined}>
              <FieldRenderer
                field={field}
                value={value}
                error={err}
                readOnly={fieldReadOnly}
                onChange={(v) => onChange(field.key, v)}
              />
            </Box>
          );
        })}
      </div>
    </Box>
  );
}

/** 单字段渲染 */
function FieldRenderer(props: {
  field: MetadataFieldDef;
  value: FormValues[string] | undefined;
  error?: string;
  readOnly: boolean;
  onChange: (v: FormValues[string]) => void;
}): ReactElement {
  const { field, value, error, readOnly, onChange } = props;
  const label = field.required ? `${field.label} *` : field.label;

  // 档号：只读等宽展示
  if (field.key === 'danghao') {
    return (
      <TextField
        label={label}
        value={String(value ?? '')}
        fullWidth
        disabled
        helperText={error ?? '档号由系统按规则生成，入库后不可修改'}
        error={Boolean(error)}
        InputProps={{ sx: { fontFamily: 'Consolas, monospace' } }}
      />
    );
  }

  // 枚举类字段：使用系统内置枚举，避免字典不一致
  if (field.key === 'retention') {
    return (
      <FormControl fullWidth error={Boolean(error)} disabled={readOnly}>
        <InputLabel>{label}</InputLabel>
        <Select
          label={label}
          value={String(value ?? 'PERM')}
          onChange={(e) => onChange(e.target.value as Retention)}
        >
          {RETENTION_VALUES.map((r) => (
            <MenuItem key={r} value={r}>
              {RETENTION_LABELS[r]}
            </MenuItem>
          ))}
        </Select>
        {error && <FormHelperText>{error}</FormHelperText>}
      </FormControl>
    );
  }

  if (field.key === 'securityLevel') {
    return (
      <FormControl fullWidth error={Boolean(error)} disabled={readOnly}>
        <InputLabel>{label}</InputLabel>
        <Select
          label={label}
          value={String(value ?? 'PUBLIC')}
          onChange={(e) => onChange(e.target.value as SecurityLevel)}
        >
          {SECURITY_LEVEL_VALUES.map((l) => (
            <MenuItem key={l} value={l}>
              {SECURITY_LEVEL_LABELS[l]}
            </MenuItem>
          ))}
        </Select>
        {error && <FormHelperText>{error}</FormHelperText>}
      </FormControl>
    );
  }

  if (field.key === 'openFlag') {
    return (
      <FormControl fullWidth error={Boolean(error)} disabled={readOnly}>
        <InputLabel>{label}</InputLabel>
        <Select
          label={label}
          value={String(value ?? 'OPEN')}
          onChange={(e) => onChange(e.target.value as OpenFlag)}
        >
          <MenuItem value="OPEN">{OPEN_FLAG_LABELS.OPEN}</MenuItem>
          <MenuItem value="CONTROLLED">{OPEN_FLAG_LABELS.CONTROLLED}</MenuItem>
        </Select>
        {error && <FormHelperText>{error}</FormHelperText>}
      </FormControl>
    );
  }

  switch (field.type) {
    case 'text':
      return (
        <TextField
          label={label}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          fullWidth
          multiline
          minRows={2}
          maxRows={8}
          disabled={readOnly}
          error={Boolean(error)}
          helperText={error ?? field.helpText}
          placeholder={field.placeholder}
          inputProps={{ maxLength: field.maxLength }}
        />
      );

    case 'number':
      return (
        <TextField
          label={label}
          type="number"
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          fullWidth
          disabled={readOnly}
          error={Boolean(error)}
          helperText={error ?? field.helpText}
        />
      );

    case 'date':
      return (
        <TextField
          label={label}
          type="date"
          value={String(value ?? '').slice(0, 10)}
          onChange={(e) => onChange(e.target.value || null)}
          fullWidth
          disabled={readOnly}
          error={Boolean(error)}
          helperText={error ?? field.helpText}
          InputLabelProps={{ shrink: true }}
        />
      );

    case 'select':
      return (
        <FormControl fullWidth error={Boolean(error)} disabled={readOnly}>
          <InputLabel>{label}</InputLabel>
          <Select
            label={label}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
          >
            {(field.options ?? []).map((o) => (
              <MenuItem key={o.value} value={o.value}>
                {o.label}
              </MenuItem>
            ))}
          </Select>
          {error ? <FormHelperText>{error}</FormHelperText> : field.helpText ? (
            <FormHelperText>{field.helpText}</FormHelperText>
          ) : null}
        </FormControl>
      );

    case 'multiselect':
      return (
        <Autocomplete
          multiple
          options={(field.options ?? []).map((o) => o.value)}
          getOptionLabel={(v) => field.options?.find((o) => o.value === v)?.label ?? v}
          value={Array.isArray(value) ? value : []}
          onChange={(_e, v) => onChange(v)}
          disabled={readOnly}
          renderTags={(tagValue, getTagProps) =>
            tagValue.map((option, index) => (
              <Chip {...getTagProps({ index })} key={option} label={
                field.options?.find((o) => o.value === option)?.label ?? option
              } />
            ))
          }
          renderInput={(params) => (
            <TextField {...params} label={label} error={Boolean(error)} helperText={error ?? field.helpText} />
          )}
        />
      );

    case 'tags':
      return (
        <Autocomplete
          multiple
          freeSolo
          options={[]}
          value={Array.isArray(value) ? value : []}
          onChange={(_e, v) => onChange(v as string[])}
          disabled={readOnly}
          renderTags={(tagValue, getTagProps) =>
            tagValue.map((option, index) => <Chip {...getTagProps({ index })} key={option} label={option} />)
          }
          renderInput={(params) => (
            <TextField
              {...params}
              label={label}
              error={Boolean(error)}
              helperText={error ?? field.helpText ?? '输入后回车添加'}
            />
          )}
        />
      );

    default:
      return (
        <TextField
          label={label}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          fullWidth
          disabled={readOnly}
          error={Boolean(error)}
          helperText={error ?? field.helpText}
          placeholder={field.placeholder}
          inputProps={{ maxLength: field.maxLength }}
        />
      );
  }
}

/** 表单校验（与后端 validatePayload 同口径，前端提前拦截） */
export function validateForm(
  fields: MetadataFieldDef[],
  values: FormValues,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    const empty =
      v === null ||
      v === undefined ||
      (typeof v === 'string' && v.trim() === '') ||
      (Array.isArray(v) && v.length === 0);
    if (f.required && empty) {
      errors[f.key] = `${f.label}不能为空`;
      continue;
    }
    if (typeof v === 'string' && f.maxLength && v.length > f.maxLength) {
      errors[f.key] = `${f.label}不得超过 ${f.maxLength} 字`;
    }
  }
  return errors;
}

/** 状态管理：受控表单值 */
export function useFormValues(initial: FormValues = {}): {
  values: FormValues;
  setValue: (key: string, value: FormValues[string]) => void;
  setValues: (v: FormValues) => void;
  reset: (v?: FormValues) => void;
} {
  const [values, setValues] = useState<FormValues>(initial);
  const setValue = (key: string, value: FormValues[string]): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };
  const reset = (v?: FormValues): void => setValues(v ?? initial);
  return { values, setValue, setValues, reset };
}

/** 空占位（避免未使用告警） */
export const EMPTY_FORM: FormValues = {};
