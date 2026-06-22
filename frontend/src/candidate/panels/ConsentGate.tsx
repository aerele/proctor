// frontend/src/candidate/panels/ConsentGate.tsx
//
// G1 (v1.1 privacy & consent) — the candidate-facing consent gate that sits in
// the form stage of the entry flow, BEFORE start() can fire. It bundles:
//
//   • ConsentDocModal       — a full-screen modal rendering the Terms OR Privacy
//                             page (markdown, react-markdown, same renderer as
//                             problem statements). Opening a page marks it viewed.
//   • ConsentDisclosurePanel— the explicit DELETED-vs-RETAINED disclosure
//                             (design §3.3); the N comes from the per-contest
//                             retention window so it is truthful per contest.
//   • ConsentGate           — the gating block: two "open the page" buttons (the
//                             consent checkboxes stay DISABLED until both pages
//                             have been opened), the right-to-consent checkbox,
//                             and the consent checkbox.
//
// The COPY for the two pages lives in ONE swappable file keyed by consent_version
// (../consentContent.ts) — see the header there. This component renders it; it
// holds no policy prose of its own beyond the disclosure list, which is derived
// from the live capture settings so it can never overstate what is captured.
//
// The four gate booleans (viewed_terms / viewed_privacy / right_to_consent /
// consent_accepted) are lifted to StudentApp's form state; candidateFormReady
// requires all four. The server re-enforces the gate (design §2.1) so a tampered
// client still cannot start.
import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText, ShieldCheck, Trash2, Archive, X, CheckCircle2, Circle } from "lucide-react";
import { consentContentFor, renderConsentMarkdown, type ConsentDoc } from "../consentContent";

export type ConsentDocKind = "terms" | "privacy";

type DocOpts = { retentionDays: number; takeHome?: boolean; proctorPhone?: string };

// ---- the full-screen Terms / Privacy modal -----------------------------------
// Rendered in-app (no external navigation) so a pre-fullscreen candidate never
// loses the proctoring context. Escape and the X both close. Scrollable body.
export function ConsentDocModal({ doc, lastUpdated, opts, onClose }: {
  doc: ConsentDoc;
  lastUpdated: string;
  opts: DocOpts;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const body = renderConsentMarkdown(doc.markdown, opts);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 backdrop-blur-sm sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={doc.title}
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-3xl rounded-lg border border-line bg-panel shadow-subtle"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div>
            <h2 className="text-xl font-semibold text-ink">{doc.title}</h2>
            <p className="mt-0.5 text-xs text-muted">Last updated: {lastUpdated}</p>
          </div>
          <button
            className="focus-ring -mr-2 inline-flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-ink/5"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="statement-markdown max-h-[70vh] overflow-y-auto px-6 py-5 text-sm leading-6 text-muted">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
        </div>
        <div className="flex justify-end border-t border-line px-6 py-3">
          <button className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white" onClick={onClose}>
            Done reading
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- DELETED vs RETAINED disclosure (design §3.3) ----------------------------
// The two columns are derived from the LIVE capture settings so they never claim
// to delete what was never captured: the camera and editor-keystroke rows only
// appear when those captures are actually on. The N (retention days) is the
// per-contest truthful window.
export function ConsentDisclosurePanel({ retentionDays, cameraRecorded, ownEditor }: {
  retentionDays: number;
  cameraRecorded: boolean;
  ownEditor: boolean;
}) {
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? Math.floor(retentionDays) : 4;
  const unit = days === 1 ? "day" : "days";

  const deleted: string[] = [
    "Your screen recording",
    ...(cameraRecorded ? ["Your camera recording"] : []),
    "Your microphone audio",
    ...(ownEditor ? ["Your keystrokes / editor activity"] : []),
    "Clipboard, tab and focus snapshots",
    "Your typed personal details (name, email)"
  ];
  const retained: string[] = [
    "Your roll number / identifier",
    "Your scores and final submission",
    "Our evaluation of your performance"
  ];

  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-4 flex items-center gap-2">
        <ShieldCheck size={18} className="text-accent" />
        <h2 className="font-semibold text-ink">What we delete, and what we keep</h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-rose-200 bg-rose-50/50 p-4">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-rose-800">
            <Trash2 size={15} /> Erased after {days} {unit}
          </p>
          <ul className="mt-2 space-y-1.5 text-sm leading-6 text-rose-900/80">
            {deleted.map((item) => (
              <li key={item} className="flex gap-2">
                <span className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-md border border-emerald-200 bg-emerald-50/50 p-4">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-800">
            <Archive size={15} /> Kept
          </p>
          <ul className="mt-2 space-y-1.5 text-sm leading-6 text-emerald-900/80">
            {retained.map((item) => (
              <li key={item} className="flex gap-2">
                <span className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted">
        Your screen and camera recordings, audio, keystrokes and personal details are permanently deleted <span className="font-medium text-ink">{days} {unit}</span> after this contest concludes. We keep only your roll number, scores and our evaluation.
      </p>
    </section>
  );
}

// ---- the gate block ----------------------------------------------------------
// Two "open the page" buttons (each marks the page viewed on open), then the two
// required checkboxes — DISABLED until both pages have been viewed. The button
// state is fully controlled by StudentApp's form; this component only renders +
// raises the changes. `consentVersion`/`retentionDays` thread through to the
// modal content. The `consentSentence` is the existing studentCopy disclosure.
export type ConsentGateState = {
  viewedTerms: boolean;
  viewedPrivacy: boolean;
  rightToConsent: boolean;
  consentAccepted: boolean;
};

export function ConsentGate({
  state,
  consentVersion,
  retentionDays,
  takeHome,
  proctorPhone,
  consentSentence,
  openDoc,
  onChange
}: {
  state: ConsentGateState;
  consentVersion: string | null | undefined;
  retentionDays: number;
  takeHome: boolean;
  proctorPhone: string;
  consentSentence: string;
  /** Open the in-app modal for a page; StudentApp owns which (if any) is open. */
  openDoc: (kind: ConsentDocKind) => void;
  onChange: (patch: Partial<ConsentGateState>) => void;
}) {
  const bothViewed = state.viewedTerms && state.viewedPrivacy;

  return (
    <div className="mt-5 rounded-lg border border-line bg-white/60 p-4">
      <p className="text-sm font-semibold text-ink">Before you start, please review and agree</p>
      <p className="mt-1 text-xs text-muted">Open both pages below. The agreement boxes unlock once you have viewed each one.</p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <DocButton kind="terms" label="Terms & Conditions" viewed={state.viewedTerms} onOpen={openDoc} />
        <DocButton kind="privacy" label="Privacy Policy" viewed={state.viewedPrivacy} onOpen={openDoc} />
      </div>

      {!bothViewed ? (
        <p className="mt-2 text-xs text-muted">Open both the Terms and the Privacy Policy to continue.</p>
      ) : null}

      <label className={`mt-4 flex gap-3 text-sm leading-6 ${bothViewed ? "text-muted" : "cursor-not-allowed text-muted/50"}`}>
        <input
          className="mt-1 h-4 w-4 accent-accent"
          type="checkbox"
          disabled={!bothViewed}
          checked={state.rightToConsent}
          onChange={(e) => onChange({ rightToConsent: e.target.checked })}
        />
        <span>I confirm I am legally able to give this consent — I am 18 or older, or I have my parent&rsquo;s or guardian&rsquo;s permission.</span>
      </label>

      <label className={`mt-3 flex gap-3 text-sm leading-6 ${bothViewed ? "text-muted" : "cursor-not-allowed text-muted/50"}`}>
        <input
          className="mt-1 h-4 w-4 accent-accent"
          type="checkbox"
          disabled={!bothViewed}
          checked={state.consentAccepted}
          onChange={(e) => onChange({ consentAccepted: e.target.checked })}
        />
        <span>{consentSentence}</span>
      </label>

      {/* consentVersion / retention / proctor only thread to the modal content;
          referenced here to keep the gate the single owner of those props. */}
      <span className="sr-only">{`consent ${consentContentFor(consentVersion).version}, retention ${retentionDays}d, ${takeHome ? `proctor ${proctorPhone}` : "on-site"}`}</span>
    </div>
  );
}

function DocButton({ kind, label, viewed, onOpen }: {
  kind: ConsentDocKind;
  label: string;
  viewed: boolean;
  onOpen: (kind: ConsentDocKind) => void;
}) {
  return (
    <button
      type="button"
      className="focus-ring flex items-center justify-between gap-3 rounded-md border border-line bg-white px-3 py-2.5 text-left text-sm hover:border-accent/50"
      onClick={() => onOpen(kind)}
    >
      <span className="flex items-center gap-2 font-medium text-ink">
        <FileText size={15} className="text-accent" /> {label}
      </span>
      {viewed ? (
        <span className="flex items-center gap-1 text-xs font-medium text-emerald-700">
          <CheckCircle2 size={14} /> Viewed
        </span>
      ) : (
        <span className="flex items-center gap-1 text-xs text-muted">
          <Circle size={14} /> Open
        </span>
      )}
    </button>
  );
}
