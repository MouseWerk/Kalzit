import { useEllipsisTitle } from "./useEllipsisTitle";

/**
 * One line of text that its column may cut with an ellipsis: whole in its title while it is cut,
 * without a title while it fits. The class brings the cutting itself (`truncate` or the like).
 */
export function CutText({ text, className }: { text: string; className?: string }) {
  const cut = useEllipsisTitle<HTMLSpanElement>(text);
  return (
    <span ref={cut.ref} className={className} title={cut.title}>
      {text}
    </span>
  );
}
