import type { ReactNode } from "react";

type Block =
  | { kind: "code"; content: string; language?: string }
  | { kind: "heading"; depth: number; content: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; content: string }
  | { kind: "paragraph"; content: string };

type InlineToken =
  | { kind: "text"; content: string }
  | { kind: "code"; content: string }
  | { kind: "strong"; content: string }
  | { kind: "em"; content: string }
  | { kind: "link"; label: string; href: string };

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="markdown-content">
      {parseBlocks(content).map((block, index) => renderBlock(block, index))}
    </div>
  );
}

function parseBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = /^```([A-Za-z0-9_-]+)?\s*$/.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        kind: "code",
        content: codeLines.join("\n"),
        language: fence[1],
      });
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        depth: heading[1]?.length ?? 1,
        content: heading[2] ?? "",
      });
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (
        index < lines.length &&
        (ordered
          ? /^\s*\d+\.\s+/.test(lines[index] ?? "")
          : /^\s*[-*]\s+/.test(lines[index] ?? ""))
      ) {
        items.push((lines[index] ?? "").replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", content: quoteLines.join("\n") });
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() !== "" &&
      !/^```/.test(lines[index] ?? "") &&
      !/^(#{1,4})\s+/.test(lines[index] ?? "") &&
      !/^\s*[-*]\s+/.test(lines[index] ?? "") &&
      !/^\s*\d+\.\s+/.test(lines[index] ?? "") &&
      !/^\s*>\s?/.test(lines[index] ?? "")
    ) {
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ kind: "paragraph", content: paragraphLines.join("\n") });
  }

  return blocks.length > 0 ? blocks : [{ kind: "paragraph", content }];
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.kind) {
    case "code":
      return (
        <pre className="markdown-code" key={index}>
          <code>{block.content}</code>
        </pre>
      );
    case "heading": {
      const Tag = `h${Math.min(block.depth + 2, 6)}` as
        | "h3"
        | "h4"
        | "h5"
        | "h6";
      return <Tag key={index}>{renderInline(block.content)}</Tag>;
    }
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag key={index}>
          {block.items.map((item, itemIndex) => (
            <li key={`${itemIndex}:${item}`}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote key={index}>{renderSoftBreaks(block.content)}</blockquote>
      );
    case "paragraph":
      return <p key={index}>{renderSoftBreaks(block.content)}</p>;
  }
}

function renderSoftBreaks(content: string): ReactNode[] {
  return content
    .split("\n")
    .flatMap((line, index) =>
      index === 0
        ? renderInline(line)
        : [<br key={`br:${index}`} />, ...renderInline(line)],
    );
}

function renderInline(content: string): ReactNode[] {
  return tokenizeInline(content).map((token, index) => {
    switch (token.kind) {
      case "code":
        return <code key={index}>{token.content}</code>;
      case "strong":
        return <strong key={index}>{token.content}</strong>;
      case "em":
        return <em key={index}>{token.content}</em>;
      case "link":
        return (
          <a
            key={index}
            href={safeHref(token.href)}
            rel="noreferrer"
            target="_blank"
          >
            {token.label}
          </a>
        );
      case "text":
        return token.content;
    }
  });
}

function tokenizeInline(content: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern =
    /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > cursor) {
      tokens.push({
        kind: "text",
        content: content.slice(cursor, match.index),
      });
    }
    if (match[2] !== undefined) {
      tokens.push({ kind: "code", content: match[2] });
    } else if (match[4] !== undefined) {
      tokens.push({ kind: "strong", content: match[4] });
    } else if (match[6] !== undefined) {
      tokens.push({ kind: "em", content: match[6] });
    } else if (match[8] !== undefined && match[9] !== undefined) {
      tokens.push({ kind: "link", label: match[8], href: match[9] });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) {
    tokens.push({ kind: "text", content: content.slice(cursor) });
  }
  return tokens;
}

function safeHref(href: string): string {
  return /^(https?:|mailto:)/i.test(href) ? href : "#";
}
