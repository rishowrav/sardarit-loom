import { SearchIcon } from "./icons";

/** Plain GET form — filters the library server-side, works without JS. */
export default function SearchBar({ initial }: { initial: string }) {
  return (
    <form action="/library" method="get" className="relative w-full sm:max-w-xs">
      <SearchIcon
        width={16}
        height={16}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
      />
      <input
        type="search"
        name="q"
        defaultValue={initial}
        placeholder="Search recordings…"
        aria-label="Search recordings"
        className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
      />
    </form>
  );
}
