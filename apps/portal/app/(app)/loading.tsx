/** Shown instantly on navigation while the server renders the next page. */
export default function Loading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="mb-6 space-y-2">
        <div className="h-7 w-48 rounded-md bg-surface-2" />
        <div className="h-4 w-72 max-w-full rounded-md bg-surface-2" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-xl border border-border bg-surface" />
        ))}
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="h-72 rounded-xl border border-border bg-surface" />
        <div className="h-48 rounded-xl border border-border bg-surface" />
      </div>
    </div>
  );
}
