// frontend/src/candidate/panels/RoomField.tsx
// Candidate leaf panel (extracted verbatim from App.tsx, F2). Props-driven.
import { useState } from "react";
import { Field } from "../../ui/Field";

// S2 — pre-fed room dropdown (+ "Other" free text). Falls back to the legacy
// free-text field when the admin has not configured any rooms.
export function RoomField({ rooms, value, onChange }: { rooms: string[]; value: string; onChange: (value: string) => void }) {
  const [otherMode, setOtherMode] = useState(() => value !== "" && !rooms.includes(value));
  if (!rooms.length) {
    return <Field label="Room number" value={value} onChange={onChange} />;
  }
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">Room number</span>
      <select
        className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
        value={otherMode ? "__other__" : value}
        onChange={(event) => {
          if (event.target.value === "__other__") {
            setOtherMode(true);
            onChange("");
          } else {
            setOtherMode(false);
            onChange(event.target.value);
          }
        }}
      >
        <option value="">Select your room…</option>
        {rooms.map((room) => (
          <option key={room} value={room}>{room}</option>
        ))}
        <option value="__other__">Other…</option>
      </select>
      {otherMode ? (
        <input
          className="focus-ring mt-2 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
          placeholder="Type your room"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </label>
  );
}
