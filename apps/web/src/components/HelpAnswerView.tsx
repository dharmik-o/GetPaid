import Link from "next/link";
import { Icon } from "@/components/Icon";
import { MANUAL_PDF, type HelpLink } from "@/lib/help-links";

// A help answer as the Help panel and the calendar assistant both show it: the answer as plain text,
// the manual sections it came from, the pages it points to, and the manual itself.

export type HelpAnswerData = {
  answer: string;
  sources: { id: string; title: string }[];
  links: HelpLink[];
};

export const HelpAnswerView = ({ answer, sources, links }: HelpAnswerData) => (
  <div className="help-answer">
    <p className="help-answer-text">{answer}</p>
    {sources.length > 0 ? (
      <p className="field-hint">
        From the manual: {sources.map((source) => source.title).join(", ")}
      </p>
    ) : null}
    {links.length > 0 ? (
      <ul className="help-links">
        {links.map((link) => (
          <li key={link.href}>
            <Link href={link.href}>{link.label}</Link>
          </li>
        ))}
      </ul>
    ) : null}
    <a className="link-button" href={MANUAL_PDF} download>
      <Icon name="file" size={16} />
      Download the manual (PDF)
    </a>
  </div>
);
