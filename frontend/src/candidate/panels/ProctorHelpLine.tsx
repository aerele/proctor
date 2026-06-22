// frontend/src/candidate/panels/ProctorHelpLine.tsx
// #135 take-home (D4 / §5b(4)): the persistent "Need help?" element shown on the
// remote candidate surface — the WaitingRoom footer and the in-exam chrome. The
// number renders as a tel: link AND as visible text (a11y: phones can dial it,
// everyone can read it). Empty phone ⇒ the element renders nothing (a take-home
// contest with no proctor_contact_phone configured simply omits the line).
import { PhoneCall } from "lucide-react";

export function ProctorHelpLine({ proctorPhone, className = "" }: { proctorPhone: string; className?: string }) {
  if (!proctorPhone) return null;
  return (
    <p className={`flex items-center gap-2 text-sm text-muted ${className}`.trim()}>
      <PhoneCall size={14} className="shrink-0 text-accent" />
      <span>
        Need help? Call your proctor:{" "}
        <a className="font-medium text-accent underline" href={`tel:${proctorPhone}`}>{proctorPhone}</a>
      </span>
    </p>
  );
}
