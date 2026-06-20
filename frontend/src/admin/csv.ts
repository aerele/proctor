// frontend/src/admin/csv.ts
// CSV builders for the admin Settings page, extracted verbatim from App.tsx (F3).
import { csvField } from "../csvField";
import type { SessionDetail } from "../types";

// Build the reviews CSV: header `candidate_id,reviewer_name,verdict`, one row
// per review record, verdict rendered as 1/0. Exported by the Settings page.
// (S-A: the user-facing CSV header says candidate_id; the wire field `username`
// inside review records stays frozen until S-E.)
export function buildReviewsCsv(reviews: Array<{ username: string; reviewer_name: string; verdict: number }>): string {
  const header = "candidate_id,reviewer_name,verdict";
  const rows = reviews.map((r) => `${csvField(r.username)},${csvField(r.reviewer_name)},${r.verdict === 1 ? 1 : 0}`);
  return [header, ...rows].join("\n");
}

// Build the candidate-details CSV: header `candidate_id,name,email,roll_number,room`,
// one row per INPUT Candidate ID (blank cells when the candidate was not found so
// the operator can see who is missing). Every field goes through csvField (escaping).
export function buildDetailsCsv(details: SessionDetail[]): string {
  const header = "candidate_id,name,email,roll_number,room";
  const rows = details.map((d) =>
    [
      csvField(d.username),
      csvField(d.found ? d.name : ""),
      csvField(d.found ? d.email : ""),
      csvField(d.found ? d.roll_number : ""),
      csvField(d.found ? d.room : "")
    ].join(",")
  );
  return [header, ...rows].join("\n");
}
