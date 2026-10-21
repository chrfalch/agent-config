// Every line is HTML-escaped before any Markdown is read, so no input can produce a tag of its own.
const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function inline(text: string): string {
  // Odd parts are the code spans the split captured; bold applies only outside them.
  return text
    .split(/(`[^`]+`)/)
    .map((part, index) => (index % 2 === 1 ? `<code>${part.slice(1, -1)}</code>` : part.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')))
    .join('');
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])[ \t]+(.*)$/;
const TABLE_ROW = /^\s*\|/;
const TABLE_RULE = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/;

function cells(row: string): string[] {
  const parts = row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/);
  return parts.map(cell => inline(cell.trim().replaceAll('\\|', '|')));
}

function table(header: string, rows: string[]): string {
  const head = cells(header).map(cell => `<th>${cell}</th>`).join('');
  const body = rows.map(row => `<tr>${cells(row).map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('\n');
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

/** Renders the Markdown a ledger uses: headings, tables, lists, fenced code, inline code and bold. */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.split('\n').map(escapeHtml);
  const blocks: string[] = [];
  let index = 0;
  const takeWhile = (keep: (line: string) => boolean): string[] => {
    const taken: string[] = [];
    while (index < lines.length && keep(lines[index] ?? '')) taken.push(lines[index++] ?? '');
    return taken;
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index++;
    } else if (FENCE.test(line)) {
      index++;
      const code = takeWhile(next => !FENCE.test(next));
      index++;
      blocks.push(`<pre><code>${code.join('\n')}</code></pre>`);
    } else if (HEADING.test(line)) {
      const [, hashes = '#', text = ''] = HEADING.exec(line) ?? [];
      blocks.push(`<h${hashes.length}>${inline(text)}</h${hashes.length}>`);
      index++;
    } else if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? '')) {
      index += 2;
      blocks.push(table(line, takeWhile(next => TABLE_ROW.test(next))));
    } else if (LIST_ITEM.test(line)) {
      const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
      const items = takeWhile(next => LIST_ITEM.test(next)).map(item => `<li>${inline(LIST_ITEM.exec(item)?.[2] ?? '')}</li>`);
      blocks.push(`<${tag}>\n${items.join('\n')}\n</${tag}>`);
    } else {
      // The first line is taken as it is: a lone table row with no rule under it is text, and must not stall the loop.
      index++;
      const paragraph = [line, ...takeWhile(next => next.trim() !== '' && ![FENCE, HEADING, LIST_ITEM, TABLE_ROW].some(start => start.test(next)))];
      blocks.push(`<p>${inline(paragraph.map(text => text.trim()).join('\n'))}</p>`);
    }
  }
  return blocks.join('\n');
}
