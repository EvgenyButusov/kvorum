'use client';

import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Section } from '@/components/ui/section';
import { MARKDOWN_PROSE_CLASS } from '@/lib/markdown';
import { cn } from '@/lib/utils';

// Above this length the description is worth clamping; shorter ones render in full with no toggle.
const CLAMP_WORDS = 120;

/**
 * Full proposal description (§6.9), rendered as GitHub-flavoured markdown. This is the source of
 * truth; the AI summary above is supplementary. A source that publishes no proposer prose falls back
 * to `derived`, the API's summary of the decoded actions. Long descriptions render in a box clamped
 * to ~320px with a fade + expand toggle (§6.9), so the section never dominates the page. The full
 * text is always in the DOM (clamp is visual only), so SSR/SEO still sees everything.
 */
export function DescriptionSection({
  description,
  derived,
}: {
  description: string;
  derived?: string | null;
}) {
  const trimmed = description.trim();
  const [expanded, setExpanded] = useState(false);
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
  const clampable = wordCount > CLAMP_WORDS;
  const showDerived = trimmed.length === 0 && derived != null && derived.trim().length > 0;

  return (
    <Section
      number="02"
      title="Description"
      reference={
        trimmed ? (
          <span>{wordCount.toLocaleString()} words</span>
        ) : showDerived ? (
          <span>derived</span>
        ) : undefined
      }
    >
      {showDerived ? (
        <DerivedDescription summary={derived.trim()} />
      ) : trimmed.length === 0 ? (
        <p className="font-mono text-mono-body text-ink-3">
          This proposal has no description text.
        </p>
      ) : (
        <div className="flex flex-col">
          <div
            className={cn(
              'relative overflow-hidden border border-line-3 bg-bg-2 px-[22px] py-[18px]',
              clampable && !expanded && 'max-h-80',
            )}
          >
            <div className={MARKDOWN_PROSE_CLASS}>
              <Markdown remarkPlugins={[remarkGfm]}>{trimmed}</Markdown>
            </div>
            {clampable && !expanded && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-b from-transparent to-bg-2"
              />
            )}
          </div>
          {clampable && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="-mt-px w-full border border-t-0 border-line-3 bg-bg-2 px-4 py-2.5 text-center font-mono text-mono-body tracking-[0.04em] text-ink-2 transition-colors hover:text-primary"
            >
              {expanded
                ? '↑ Collapse description'
                : `↓ Expand full description (${wordCount.toLocaleString()} words)`}
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

// Shown in place of proposer prose for sources that publish none (Easy Track motions). Labelled as
// derived so it is never mistaken for text a proposer wrote, which is what §5.6 audits against.
function DerivedDescription({ summary }: { summary: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-mono text-mono-body text-ink-3">
        This proposal carries no author text. The summary below is derived from its decoded on-chain
        actions.
      </p>
      <div className="border border-dashed border-line-3 bg-bg-2 px-[22px] py-[18px]">
        <div className={MARKDOWN_PROSE_CLASS}>
          <Markdown remarkPlugins={[remarkGfm]}>{summary}</Markdown>
        </div>
      </div>
    </div>
  );
}
