/** CSV cells are quoted and spreadsheet formula prefixes are neutralized. */
export function exportCsv(name: string, rows: readonly (readonly (string | number | null)[])[]) {
  const csv = rows
    .map((row) =>
      row
        .map((value) => {
          let cell = String(value ?? '');
          if (/^[\s]*[=+\-@]/.test(cell)) cell = `'${cell}`;
          return `"${cell.replaceAll('"', '""')}"`;
        })
        .join(','),
    )
    .join('\r\n');
  download(name, new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
}
export function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replaceAll(/[\\/]/g, '_');
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const fieldClass =
  'bg-field text-text border-border-3 rounded-control border px-3 py-2 text-body outline-none transition-colors focus:border-accent-hover focus:ring-3 focus:ring-accent-hover/20';
