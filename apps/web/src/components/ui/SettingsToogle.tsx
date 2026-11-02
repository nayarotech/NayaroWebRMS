// yo component le title ra description lai compulsory magxa: by default checked false
export default function SettingToggle({
  title,
  description,
  defaultChecked = false,
}: {
  title: string;
  description: string;
  defaultChecked?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div>
        <h3 className="text-[1rem] font-medium text-slate-900">{title}</h3>

        <p className="text-sm text-slate-500">{description}</p>
      </div>

      <label className="relative inline-flex cursor-pointer items-center">
        <input type="checkbox" defaultChecked={defaultChecked} className="peer sr-only" />

        <div className="h-8 w-14 rounded-full bg-slate-200 transition peer-checked:bg-blue-600" />

        <div className="absolute left-1 top-1 h-6 w-6 rounded-full bg-white shadow-sm transition peer-checked:translate-x-6" />
      </label>
    </div>
  );
}
