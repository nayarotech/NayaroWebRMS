export function StaffRow({
  initials,
  name,
  username,
  role,
  access,
  status,
}: {
  initials: string;
  name: string;
  username: string;
  role: string;
  access: string;
  status: string;
}) {
  return (
    <div className="grid grid-cols-[2fr_1fr_3fr_1fr] items-center border-t border-slate-200 px-5 py-4">
      {/* Staff */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-100 text-sm font-semibold text-blue-600">
          {initials}
        </div>

        <div>
          <p className="font-semibold text-slate-900">{name}</p>

          <p className="text-sm text-slate-500">{username}</p>
        </div>
      </div>

      {/* Role */}
      <div>
        <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-600">
          {role}
        </span>
      </div>

      {/* Access */}
      <p className="text-sm text-slate-500">{access}</p>

      {/* Status */}
      <p className="text-right text-sm font-medium text-green-600">{status}</p>
    </div>
  );
}
