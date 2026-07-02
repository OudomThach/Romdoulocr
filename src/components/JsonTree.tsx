import { useState } from 'react';
import { copyToClipboard } from '@/lib/utils';

interface JsonTreeProps {
  data: unknown;
  maxHeight?: string;
}

export function JsonTree({ data, maxHeight = '480px' }: JsonTreeProps) {
  return (
    <div
      className="overflow-auto rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-xs leading-relaxed"
      style={{ maxHeight }}
    >
      <JsonNode value={data} depth={0} path="$" />
    </div>
  );
}

function JsonNode({ value, depth, path }: { value: unknown; depth: number; path: string }) {
  if (value === null) return <span className="text-ink-500">null</span>;
  if (typeof value === 'boolean') return <span className="text-amber-400">{String(value)}</span>;
  if (typeof value === 'number') return <span className="text-cyan-400">{value}</span>;
  if (typeof value === 'string') {
    if (value.length === 0) return <span className="text-green-400">&quot;&quot;</span>;
    if (value.length < 80)
      return (
        <span
          className="cursor-pointer text-green-400 hover:text-green-300"
          title={`Click to copy · ${value.length} ch`}
          onClick={async () => {
            await copyToClipboard(value);
          }}
        >
          &quot;{value}&quot;
        </span>
      );
    return (
      <span className="text-green-400">
        &quot;<span className="cursor-pointer hover:text-green-300" title="Click to copy" onClick={async () => { await copyToClipboard(value); }}>{value}</span>&quot;
      </span>
    );
  }
  if (Array.isArray(value)) return <JsonArray value={value} depth={depth} path={path} />;
  if (typeof value === 'object') return <JsonObject value={value as Record<string, unknown>} depth={depth} path={path} />;
  return <span className="text-ink-500">{String(value)}</span>;
}

function JsonArray({ value, depth, path }: { value: unknown[]; depth: number; path: string }) {
  const [open, setOpen] = useState(depth < 2);
  const pad = '  '.repeat(depth);
  const innerPad = '  '.repeat(depth + 1);

  if (!open) {
    return (
      <span
        onClick={() => setOpen(true)}
        className="cursor-pointer text-ink-300 hover:text-ink-50"
      >
        [{value.length}] … <span className="text-ink-500">({value.length} item{value.length !== 1 ? 's' : ''})</span>
      </span>
    );
  }

  return (
    <span>
      <span
        onClick={() => setOpen(false)}
        className="cursor-pointer text-ink-300 hover:text-ink-50"
      >
        [{value.length}]
      </span>
      {'\n'}
      {value.map((item, i) => (
        <span key={i}>
          {innerPad}
          <span className="text-ink-500">{i}: </span>
          <JsonNode value={item} depth={depth + 1} path={`${path}[${i}]`} />
          {i < value.length - 1 ? ',' : ''}
          {'\n'}
        </span>
      ))}
      {pad}]
    </span>
  );
}

function JsonObject({ value, depth, path }: { value: Record<string, unknown>; depth: number; path: string }) {
  const [open, setOpen] = useState(depth < 2);
  const keys = Object.keys(value);
  const pad = '  '.repeat(depth);
  const innerPad = '  '.repeat(depth + 1);

  if (!open) {
    return (
      <span
        onClick={() => setOpen(true)}
        className="cursor-pointer text-ink-300 hover:text-ink-50"
      >
        {'{'}…{'}'} <span className="text-ink-500">({keys.length} key{keys.length !== 1 ? 's' : ''})</span>
      </span>
    );
  }

  return (
    <span>
      <span
        onClick={() => setOpen(false)}
        className="cursor-pointer text-ink-300 hover:text-ink-50"
      >
        {'{'}
      </span>
      {'\n'}
      {keys.map((key, i) => {
        const v = value[key];
        const isSimple = v === null || typeof v !== 'object';
        return (
          <span key={key}>
            {innerPad}
            <span
              className="cursor-pointer text-sky-400 hover:text-sky-300"
              title="Click to copy key"
              onClick={async (e) => {
                e.stopPropagation();
                await copyToClipboard(key);
              }}
            >
              &quot;{key}&quot;
            </span>
            <span className="text-ink-600">: </span>
            {isSimple ? (
              <JsonNode value={v} depth={depth + 1} path={`${path}.${key}`} />
            ) : (
              <JsonNode value={v} depth={depth + 1} path={`${path}.${key}`} />
            )}
            {i < keys.length - 1 ? ',' : ''}
            {'\n'}
          </span>
        );
      })}
      {pad}
      {'}'}
    </span>
  );
}
