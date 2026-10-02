import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** 复制按钮：成功后短暂显示「Copied」。剪贴板不可用（非安全上下文）时提示手动选择。 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className="button button-quiet copy-button"
      aria-label={`Copy ${label}`}
      onClick={() => {
        // 剪贴板接口只在安全上下文（https 或 localhost）里存在。
        if (navigator.clipboard) {
          navigator.clipboard.writeText(value).then(
            () => setState('copied'),
            () => setState('failed'),
          );
        } else {
          setState('failed');
        }
        window.setTimeout(() => setState('idle'), 1_600);
      }}
    >
      {state === 'copied' ? <Check size={13} /> : <Copy size={13} />}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy' : 'Copy'}
    </button>
  );
}
