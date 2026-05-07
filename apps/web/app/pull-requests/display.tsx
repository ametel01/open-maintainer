import type { ReactNode } from "react";
import React, { createElement } from "react";

type MarkdownBlock =
  | { kind: "blockquote"; text: string }
  | { kind: "code"; language: string | null; text: string }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "hr" }
  | {
      kind: "list";
      ordered: boolean;
      items: Array<{ checked: boolean | null; text: string }>;
    }
  | { kind: "paragraph"; text: string };

export function LabelChips({
  ariaLabel = "Labels",
  className = "pr-label-chips",
  emptyLabel = null,
  labels,
  limit,
}: {
  ariaLabel?: string;
  className?: string;
  emptyLabel?: string | null;
  labels: readonly string[];
  limit?: number;
}) {
  if (labels.length === 0) {
    return emptyLabel ? <p className="muted">{emptyLabel}</p> : null;
  }
  const visibleLabels =
    limit && limit > 0 ? labels.slice(0, limit) : [...labels];
  const hiddenCount = Math.max(0, labels.length - visibleLabels.length);
  return (
    <div aria-label={ariaLabel} className={className}>
      {visibleLabels.map((label) => (
        <span className="badge pr-label" key={label} title={label}>
          {label}
        </span>
      ))}
      {hiddenCount > 0 ? (
        <span className="badge subtle pr-label" title={labels.join(", ")}>
          +{hiddenCount}
        </span>
      ) : null}
    </div>
  );
}

export function MarkdownBody({
  className,
  value,
}: {
  className?: string;
  value: string;
}) {
  const blocks = parseMarkdownBlocks(value);
  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      {blocks.map((block, index) => renderMarkdownBlock(block, index))}
    </div>
  );
}

function parseMarkdownBlocks(value: string): MarkdownBlock[] {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^(```|~~~)\s*([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      const marker = fence[1] ?? "```";
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith(marker)) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({
        kind: "code",
        language: fence[2] ?? null,
        text: codeLines.join("\n"),
      });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading?.[1] && heading[2]) {
      blocks.push({
        kind: "heading",
        level: markdownHeadingLevel(heading[1].length),
        text: heading[2],
      });
      index += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }

    if (isListLine(line)) {
      const ordered = isOrderedListLine(line);
      const items: Array<{ checked: boolean | null; text: string }> = [];
      while (
        index < lines.length &&
        isListLine(lines[index] ?? "") &&
        isOrderedListLine(lines[index] ?? "") === ordered
      ) {
        const item = parseListItem(lines[index] ?? "");
        items.push(item);
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (
        index < lines.length &&
        (lines[index] ?? "").trim().startsWith(">")
      ) {
        quoteLines.push((lines[index] ?? "").trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "blockquote", text: quoteLines.join("\n") });
      continue;
    }

    const paragraphLines = [trimmed];
    index += 1;
    while (
      index < lines.length &&
      lines[index]?.trim() &&
      !isBlockStart(lines[index] ?? "")
    ) {
      paragraphLines.push((lines[index] ?? "").trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks.length ? blocks : [{ kind: "paragraph", text: value }];
}

function renderMarkdownBlock(block: MarkdownBlock, index: number): ReactNode {
  const key = `markdown-block-${index}`;
  if (block.kind === "heading") {
    return createElement(
      `h${block.level}`,
      { key },
      renderInlineMarkdown(block.text, key),
    );
  }
  if (block.kind === "code") {
    return (
      <pre
        className="markdown-code-block"
        data-language={block.language ?? undefined}
        key={key}
      >
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.kind === "blockquote") {
    return (
      <blockquote key={key}>{renderInlineMarkdown(block.text, key)}</blockquote>
    );
  }
  if (block.kind === "hr") {
    return <hr key={key} />;
  }
  if (block.kind === "list") {
    const List = block.ordered ? "ol" : "ul";
    const hasTasks = block.items.some((item) => item.checked !== null);
    return createElement(
      List,
      {
        className: hasTasks ? "markdown-task-list" : undefined,
        key,
      },
      block.items.map((item, itemIndex) => (
        <li
          className={item.checked !== null ? "markdown-task-item" : undefined}
          key={`${key}-${item.checked ?? "plain"}-${item.text}`}
        >
          {item.checked !== null ? (
            <input
              aria-label={item.checked ? "Completed" : "Incomplete"}
              checked={item.checked}
              readOnly
              type="checkbox"
            />
          ) : null}
          <span>{renderInlineMarkdown(item.text, `${key}-${itemIndex}`)}</span>
        </li>
      )),
    );
  }
  return <p key={key}>{renderInlineMarkdown(block.text, key)}</p>;
}

function markdownHeadingLevel(level: number): 1 | 2 | 3 | 4 | 5 | 6 {
  if (level <= 1) {
    return 1;
  }
  if (level >= 6) {
    return 6;
  }
  return level as 2 | 3 | 4 | 5;
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let textBuffer = "";
  let index = 0;
  let keyIndex = 0;

  const pushText = () => {
    if (textBuffer) {
      nodes.push(textBuffer);
      textBuffer = "";
    }
  };
  const nextKey = (kind: string) => `${keyPrefix}-${kind}-${keyIndex++}`;

  while (index < text.length) {
    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        pushText();
        nodes.push(
          <code key={nextKey("code")}>{text.slice(index + 1, end)}</code>,
        );
        index = end + 1;
        continue;
      }
    }

    if (text.startsWith("**", index)) {
      const end = text.indexOf("**", index + 2);
      if (end > index + 2) {
        pushText();
        nodes.push(
          <strong key={nextKey("strong")}>
            {renderInlineMarkdown(
              text.slice(index + 2, end),
              nextKey("strong-inner"),
            )}
          </strong>,
        );
        index = end + 2;
        continue;
      }
    }

    if (text[index] === "[") {
      const closeText = text.indexOf("]", index + 1);
      const openHref = closeText >= 0 ? text.indexOf("(", closeText) : -1;
      const closeHref = openHref >= 0 ? text.indexOf(")", openHref) : -1;
      if (
        closeText > index + 1 &&
        openHref === closeText + 1 &&
        closeHref > openHref + 1
      ) {
        const label = text.slice(index + 1, closeText);
        const href = safeMarkdownHref(text.slice(openHref + 1, closeHref));
        if (href) {
          pushText();
          nodes.push(
            <a
              href={href}
              key={nextKey("link")}
              rel="noreferrer"
              target="_blank"
            >
              {renderInlineMarkdown(label, nextKey("link-label"))}
            </a>,
          );
          index = closeHref + 1;
          continue;
        }
      }
    }

    const rawUrl = text.slice(index).match(/^https?:\/\/[^\s<)]+[^\s<).,!?]/);
    if (rawUrl?.[0]) {
      pushText();
      nodes.push(
        <a
          href={rawUrl[0]}
          key={nextKey("url")}
          rel="noreferrer"
          target="_blank"
        >
          {rawUrl[0]}
        </a>,
      );
      index += rawUrl[0].length;
      continue;
    }

    textBuffer += text[index];
    index += 1;
  }

  pushText();
  return nodes;
}

function isBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^(```|~~~)/.test(trimmed) ||
    /^(#{1,6})\s+/.test(trimmed) ||
    /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed) ||
    trimmed.startsWith(">") ||
    isListLine(line)
  );
}

function isListLine(line: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line);
}

function isOrderedListLine(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line);
}

function parseListItem(line: string): {
  checked: boolean | null;
  text: string;
} {
  const text = line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");
  const task = text.match(/^\[( |x|X)\]\s+(.+)$/);
  if (!task?.[1] || !task[2]) {
    return { checked: null, text };
  }
  return { checked: task[1].toLowerCase() === "x", text: task[2] };
}

function safeMarkdownHref(rawHref: string): string | null {
  const href = rawHref.trim();
  if (href.startsWith("/") || href.startsWith("#")) {
    return href;
  }
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
