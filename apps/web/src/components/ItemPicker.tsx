import { useMemo, useState, type ReactElement } from 'react';
import { Autocomplete, Chip, CircularProgress, TextField } from '@mui/material';
import { useQuery } from '@tanstack/react-query';

/** 自动补全候选项 */
export interface ItemOption {
  id: string;
  danghao: string;
  title: string;
  year?: number;
  retention?: string;
  securityLevel?: string;
}

export interface ItemPickerProps {
  label: string;
  value: ItemOption[];
  onChange: (next: ItemOption[]) => void;
  /** 按关键词取候选（外部注入，便于复用不同权限域的检索接口） */
  fetcher: (keyword: string) => Promise<ItemOption[]>;
  multiple?: boolean;
  placeholder?: string;
  disabled?: boolean;
  size?: 'small' | 'medium';
  helperText?: string;
}

/**
 * 档号/题名自动补全选择器。
 *
 * 目的：把「手工抄档号」换成「输几个字选一条」，减少错录。
 * 输入 2 个字符以上才触发检索，避免打开就全表扫描；
 * 候选项展示 档号 + 题名 + 年度，重复题名也能靠档号区分。
 */
export function ItemPicker(props: ItemPickerProps): ReactElement {
  const {
    label,
    value,
    onChange,
    fetcher,
    multiple = true,
    placeholder = '输入档号或题名关键字',
    disabled = false,
    size = 'small',
    helperText,
  } = props;

  const [input, setInput] = useState<string>('');
  const keyword = input.trim();

  const optionsQuery = useQuery({
    queryKey: ['item-picker', label, keyword],
    queryFn: () => fetcher(keyword),
    enabled: keyword.length >= 2,
    staleTime: 15_000,
  });

  const options = useMemo(() => {
    const list = optionsQuery.data ?? [];
    // 已选中的不再出现在候选里，避免重复添加
    const picked = new Set(value.map((v) => v.id));
    return list.filter((o) => !picked.has(o.id));
  }, [optionsQuery.data, value]);

  return (
    <Autocomplete
      multiple={multiple}
      size={size}
      disabled={disabled}
      options={options}
      value={value}
      loading={optionsQuery.isFetching}
      filterOptions={(x) => x}
      getOptionLabel={(o) => `${o.danghao} ${o.title}`}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      onChange={(_e, next) => {
        onChange(multiple ? (next as ItemOption[]) : next ? [next as ItemOption] : []);
      }}
      onInputChange={(_e, v) => setInput(v)}
      noOptionsText={keyword.length < 2 ? '输入至少 2 个字符开始检索' : '没有匹配的档案'}
      renderTags={(items, getTagProps) =>
        items.map((option, index) => (
          <Chip
            {...getTagProps({ index })}
            key={option.id}
            size="small"
            label={`${option.danghao} ${option.title}`}
          />
        ))
      }
      renderOption={(props, option) => (
        <li {...props} key={option.id}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', width: '100%' }}>
            <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{option.danghao}</span>
            <span style={{ flex: 1 }}>{option.title}</span>
            <span style={{ fontSize: 11, opacity: 0.65 }}>
              {option.year ?? ''} {option.retention ?? ''}
            </span>
          </div>
        </li>
      )}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          placeholder={placeholder}
          helperText={helperText}
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {optionsQuery.isFetching ? <CircularProgress color="inherit" size={16} /> : null}
                {params.InputProps.endAdornment}
              </>
            ),
          }}
        />
      )}
    />
  );
}
