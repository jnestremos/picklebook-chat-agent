'use client';

import { createElement, Fragment, type ReactNode } from 'react';
import styles from './chat.module.css';

/** Inline `**bold**` segments; plain text is escaped by React. */
function formatInlineBold(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(<strong key={k++}>{m[1]}</strong>);
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length ? nodes : [text];
}

function isBulletLine(line: string): boolean {
  return /^(\s*[-•*]|\s*\d+[.)])\s+/.test(line);
}

function stripBulletPrefix(line: string): string {
  return line.replace(/^(\s*[-•*]|\s*\d+[.)])\s+/, '').trim();
}

/** Heuristic: time rows vs court/price header rows inside venue lists. */
function listItemKind(content: string): 'slot' | 'meta' | 'default' {
  const t = content.trim();
  if (/^\d{1,2}:\d{2}\s*(a\.?m\.?|p\.?m\.?)\b/i.test(t)) return 'slot';
  if (/₱|PHP|per\s+hour/i.test(t)) return 'meta';
  if (/^court\b/i.test(t)) return 'meta';
  return 'default';
}

function listItemClass(kind: 'slot' | 'meta' | 'default'): string {
  if (kind === 'slot') return `${styles.assistantListItem} ${styles.assistantListItemSlot}`;
  if (kind === 'meta') return `${styles.assistantListItem} ${styles.assistantListItemMeta}`;
  return styles.assistantListItem;
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'para'; lines: string[] }
  | { type: 'table'; header: string[]; rows: string[][] };

function splitPipeRow(line: string): string[] {
  const s = line.trimEnd();
  if (!s.startsWith('|')) return [];
  const core = s.replace(/^\|/, '').replace(/\|\s*$/, '');
  return core.split('|').map((c) => c.trim());
}

function isMarkdownTableSeparatorRow(line: string): boolean {
  const cells = splitPipeRow(line);
  if (cells.length < 2) return false;
  return cells.every((c) => /^:?-{3,}:?$/.test(c.replace(/\s/g, '')));
}

function parseMarkdownTable(lines: string[], start: number): { block: Block; nextIndex: number } | null {
  const headerLine = lines[start]?.trimEnd() ?? '';
  if (!headerLine.trim().startsWith('|')) return null;
  const sepLine = lines[start + 1]?.trimEnd() ?? '';
  if (!sepLine.trim().startsWith('|') || !isMarkdownTableSeparatorRow(sepLine)) return null;
  const header = splitPipeRow(headerLine);
  if (header.length < 2 || header.every((h) => h === '')) return null;

  let i = start + 2;
  const rows: string[][] = [];
  while (i < lines.length) {
    const L = lines[i].trimEnd();
    if (L.trim() === '') break;
    const t = L.trim();
    if (!t.startsWith('|')) break;
    if (isMarkdownTableSeparatorRow(L)) {
      i += 1;
      continue;
    }
    rows.push(splitPipeRow(L));
    i += 1;
  }

  const nCols = header.length;
  const norm = (cells: string[]) => {
    const out = [...cells];
    while (out.length < nCols) out.push('');
    if (out.length > nCols) out.length = nCols;
    return out;
  };
  const normRows = rows.map(norm);

  return { block: { type: 'table', header, rows: normRows }, nextIndex: i };
}

function parseBlocks(text: string): Block[] {
  const lines = text.trimEnd().split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed === '') {
      i += 1;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2],
      });
      i += 1;
      continue;
    }

    const tbl = parseMarkdownTable(lines, i);
    if (tbl) {
      blocks.push(tbl.block);
      i = tbl.nextIndex;
      continue;
    }

    if (isBulletLine(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const L = lines[i].trimEnd();
        if (L.trim() === '') break;
        if (!isBulletLine(L)) break;
        items.push(L);
        i += 1;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length) {
      const L = lines[i].trimEnd();
      if (L.trim() === '') break;
      if (/^(#{1,6})\s+/.test(L.trim())) break;
      if (isBulletLine(L)) break;
      if (L.trim().startsWith('|') && parseMarkdownTable(lines, i) !== null) break;
      paraLines.push(L);
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'para', lines: paraLines });
    }
  }

  return blocks;
}

function headingTag(level: number): 'h2' | 'h3' | 'h4' {
  if (level <= 2) return 'h2';
  if (level === 3) return 'h3';
  return 'h4';
}

function renderHeading(level: number, text: string) {
  const tag = headingTag(level);
  return createElement(tag, { className: styles.assistantHeading }, ...formatInlineBold(text));
}

function renderTable(header: string[], rows: string[][], reactKey: string) {
  const nCols = header.length;
  const normCells = (cells: string[]) => {
    const out = [...cells];
    while (out.length < nCols) out.push('');
    if (out.length > nCols) out.length = nCols;
    return out;
  };
  return (
    <div key={reactKey} className={styles.assistantTableWrap}>
      <table className={styles.assistantTable}>
        <thead>
          <tr>
            {header.map((h, hi) => (
              <th key={hi}>{formatInlineBold(h)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {normCells(row).map((cell, ci) => (
                <td key={ci}>{formatInlineBold(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderList(items: string[], reactKey: string, inSection = false) {
  const listClass = inSection
    ? `${styles.assistantList} ${styles.assistantListSection}`
    : styles.assistantList;
  return (
    <ul key={reactKey} className={listClass}>
      {items.map((line, li) => {
        const inner = stripBulletPrefix(line);
        const kind = listItemKind(inner);
        return (
          <li key={li} className={listItemClass(kind)}>
            {formatInlineBold(inner)}
          </li>
        );
      })}
    </ul>
  );
}

function renderParagraph(lines: string[], reactKey: string) {
  return (
    <p key={reactKey} className={styles.assistantPara}>
      {lines.map((line, li) => (
        <Fragment key={li}>
          {li > 0 ? <br /> : null}
          {formatInlineBold(line)}
        </Fragment>
      ))}
    </p>
  );
}

export function AssistantMessageBody({ text }: { text: string }) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const blocks = parseBlocks(trimmed);
  const nodes: ReactNode[] = [];

  for (let bi = 0; bi < blocks.length; bi += 1) {
    const b = blocks[bi];
    if (b.type === 'heading') {
      const next = blocks[bi + 1];
      const after = blocks[bi + 2];
      if (next?.type === 'para' && after?.type === 'table') {
        nodes.push(
          <section key={`sec-${bi}`} className={styles.assistantSection}>
            {renderHeading(b.level, b.text)}
            {renderParagraph(next.lines, `p-${bi}`)}
            {renderTable(after.header, after.rows, `tbl-${bi}`)}
          </section>,
        );
        bi += 2;
        continue;
      }
      if (next?.type === 'list') {
        nodes.push(
          <section key={`sec-${bi}`} className={styles.assistantSection}>
            {renderHeading(b.level, b.text)}
            {renderList(next.items, `ul-${bi}`, true)}
          </section>,
        );
        bi += 1;
        continue;
      }
      if (next?.type === 'para') {
        nodes.push(
          <section key={`sec-${bi}`} className={styles.assistantSection}>
            {renderHeading(b.level, b.text)}
            {renderParagraph(next.lines, `p-${bi}`)}
          </section>,
        );
        bi += 1;
        continue;
      }
      if (next?.type === 'table') {
        nodes.push(
          <section key={`sec-${bi}`} className={styles.assistantSection}>
            {renderHeading(b.level, b.text)}
            {renderTable(next.header, next.rows, `tbl-${bi}`)}
          </section>,
        );
        bi += 1;
        continue;
      }
      nodes.push(
        <section key={`sec-${bi}`} className={styles.assistantSection}>
          {renderHeading(b.level, b.text)}
        </section>,
      );
      continue;
    }

    if (b.type === 'list') {
      nodes.push(renderList(b.items, `ul-${bi}`));
      continue;
    }

    if (b.type === 'table') {
      nodes.push(renderTable(b.header, b.rows, `tbl-${bi}`));
      continue;
    }

    nodes.push(renderParagraph(b.lines, `p-${bi}`));
  }

  return <div className={styles.assistantRich}>{nodes}</div>;
}
