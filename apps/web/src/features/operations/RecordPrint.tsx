import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { paperSpec, readPaperPreference } from '@/features/billing/print/paperPreference';

export function RecordPrint({ children, onDone }: { children: ReactNode; onDone: () => void }) {
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);
  const spec = paperSpec(readPaperPreference());
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `@page { size: ${spec.pageSize}; margin: ${spec.continuous ? '0' : '12mm'}; }`;
    document.head.append(style);
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        window.print();
        done.current();
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      style.remove();
    };
  }, [spec.pageSize, spec.continuous]);
  const target = document.getElementById('print-root');
  return target
    ? createPortal(
        <div
          style={{
            width: spec.widthCss,
            color: '#000',
            background: '#fff',
            font: '12px monospace',
            paddingBottom: '12mm',
            overflowWrap: 'anywhere',
          }}
        >
          {children}
        </div>,
        target,
      )
    : null;
}
