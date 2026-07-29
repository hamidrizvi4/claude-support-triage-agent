import type { Citation } from "@/lib/data/types";
import { matchCitation, isHttpUrl } from "./logic";
import styles from "./drawer.module.css";

/**
 * The drafts are markdown-ish (headings, **bold**, `code`, [links](url), pipe
 * tables). Rendering the handful of constructs that actually occur is ~60 lines;
 * a markdown dependency for that would be the heavier choice.
 */

const INLINE = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g;

function CitationChip({ label, citation }: { label: string; citation: Citation }) {
  return (
    <a
      className={styles.cite}
      href={citation.source_url}
      target="_blank"
      rel="noopener noreferrer"
    >
      <span className={styles.citeMarker} aria-hidden="true">
        ◆
      </span>
      {label}
      <span className={styles.tooltip} role="tooltip">
        {citation.title}
        <span className={styles.tooltipUrl}>{citation.source_url}</span>
      </span>
    </a>
  );
}

function renderInline(
  text: string,
  citations: Citation[],
  cited: Set<string>,
  keyPrefix: string
): React.ReactNode[] {
  const parts = text.split(INLINE);

  return parts.filter(Boolean).map((part, i) => {
    const key = `${keyPrefix}-${i}`;

    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const [, label, url] = link;
      const citation = matchCitation(url, citations);
      if (citation) {
        cited.add(citation.source_url);
        return <CitationChip key={key} label={label} citation={citation} />;
      }
      if (!isHttpUrl(url)) {
        return <span key={key}>{label}</span>;
      }
      return (
        <a
          key={key}
          className={styles.link}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {label}
        </a>
      );
    }

    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }

    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={key} className={styles.code}>
          {part.slice(1, -1)}
        </code>
      );
    }

    return <span key={key}>{part}</span>;
  });
}

export function DraftBody({
  text,
  citations,
}: {
  text: string;
  citations: Citation[];
}) {
  const cited = new Set<string>();
  const blocks: React.ReactNode[] = [];

  const lines = text.split("\n");
  let paragraph: string[] = [];
  let table: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const key = `p${blocks.length}`;
    blocks.push(
      <p key={key} className={styles.draftP}>
        {renderInline(paragraph.join("\n"), citations, cited, key)}
      </p>
    );
    paragraph = [];
  };

  const flushTable = () => {
    if (table.length === 0) return;
    blocks.push(
      <pre key={`t${blocks.length}`} className={styles.draftPre}>
        {table.join("\n")}
      </pre>
    );
    table = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("|")) {
      flushParagraph();
      table.push(line);
      continue;
    }
    flushTable();

    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) {
      flushParagraph();
      const key = `h${blocks.length}`;
      blocks.push(
        <h4 key={key} className={styles.draftH}>
          {renderInline(heading[1], citations, cited, key)}
        </h4>
      );
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    paragraph.push(line);
  }
  flushTable();
  flushParagraph();

  // Anything the agent cited but didn't link inline still has to be visible.
  const unlinked = citations.filter((c) => !cited.has(c.source_url));

  return (
    <div className={styles.draft}>
      {blocks}
      {unlinked.length > 0 && (
        <div className={styles.sources}>
          <span className={styles.sourcesLabel}>Sources</span>
          {unlinked.map((c) => (
            <CitationChip
              key={c.source_url}
              label={c.title.length > 42 ? `${c.title.slice(0, 42)}…` : c.title}
              citation={c}
            />
          ))}
        </div>
      )}
    </div>
  );
}
