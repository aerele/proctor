// frontend/src/admin/views/RoomFilter.tsx
// Shared admin room dropdown (used by StatsDashboard + AlertsConsole),
// extracted verbatim from App.tsx (F3).

// Shared room dropdown — populated from the response `rooms` list (full contest
// scope) so it always lists every room even while one is selected.
export function RoomFilter({ rooms, value, onChange }: { rooms: string[]; value: string; onChange: (room: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">Room</span>
      <select className="focus-ring mt-1 h-10 w-44 rounded-md border border-line bg-white px-3 text-sm" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">All rooms</option>
        {rooms.map((label) => (
          <option key={label} value={label}>{label}</option>
        ))}
      </select>
    </label>
  );
}
