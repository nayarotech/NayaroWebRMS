export type TableColumn<T extends object> = {
  key: keyof T | string;
  header: string;
  render?: (value: unknown, row: T) => React.ReactNode;
  className?: string;
};

type DataTableProps<T extends object> = {
  columns: TableColumn<T>[];
  data: T[];
  getRowKey?: (row: T, index: number) => string | number;
};

export function DataTable<T extends object>({ columns, data, getRowKey }: DataTableProps<T>) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200">
      <table className="w-full border-collapse">
        <thead className="bg-slate-50">
          <tr>
            {columns.map((column) => (
              <th
                key={column.header}
                className={`px-5 py-4 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 ${
                  column.className ?? ''
                }`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {data.map((row, index) => (
            <tr key={getRowKey?.(row, index) ?? index} className="border-t border-slate-200">
              {columns.map((column) => {
                const value = column.key in row ? row[column.key as keyof T] : undefined;

                return (
                  <td
                    key={String(column.key)}
                    className={`px-5 py-4 text-sm text-slate-600 ${column.className ?? ''}`}
                  >
                    {column.render ? column.render(value, row) : String(value ?? '')}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
