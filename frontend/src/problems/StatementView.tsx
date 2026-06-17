// frontend/src/problems/StatementView.tsx
//
// W6: THE shared problem-statement renderer — used by the candidate workspace
// (CodingWorkspace ProblemPane) and the admin authoring preview, so the two
// can never drift.
//
//   format absent/"plain"  -> EXACTLY today's path: one pre-wrapped <p> with
//                             the same classes the candidate pane always used.
//   format "markdown"      -> react-markdown + remark-gfm (headings, lists,
//                             inline/block code, tables, strikethrough).
//
// SAFETY: react-markdown renders NO raw HTML by default — embedded HTML in a
// statement comes out as escaped text, never as elements (no
// dangerouslySetInnerHTML, no rehype-raw anywhere). Statements are
// admin-authored but candidate-viewed, so this is the posture we keep.
// Markdown typography is styled via the scoped .statement-markdown rules in
// styles.css (matching the pane's text-sm/text-muted look and the mono font
// the sample tests already use).
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { StatementFormat } from "../types";

export function StatementView({ statement, format, className = "" }: {
  statement: string;
  /** Absent (older backends / pre-W6 problems) renders as plain. */
  format?: StatementFormat;
  /** Extra classes on the root node (call sites pass spacing, e.g. "mt-2"). */
  className?: string;
}) {
  if (format !== "markdown") {
    // The pre-W6 candidate statement, byte-for-byte (class order included).
    return <p className={`${className} whitespace-pre-wrap text-sm text-muted`.trim()}>{statement}</p>;
  }
  return (
    <div className={`statement-markdown ${className} text-sm text-muted`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{statement}</ReactMarkdown>
    </div>
  );
}
