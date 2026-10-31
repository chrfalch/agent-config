import stringWidth from 'string-width';

export type Align = 'left' | 'right';

function pad(text: string, size: number, align: Align): string {
  const fill = ' '.repeat(Math.max(0, size - stringWidth(text)));
  return align === 'right' ? fill + text : text + fill;
}

/** One line per row, header first, each column as wide as its widest cell. Color codes take no width. */
export function table(header: string[], rows: string[][], align: Align[] = []): string[] {
  const lines = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...lines.map(row => stringWidth(row[column] ?? ''))));
  return lines.map(row => widths.map((size, column) => pad(row[column] ?? '', size, align[column] ?? 'left')).join('  ').trimEnd());
}

export function truncate(text: string, size: number): string {
  if (size <= 0) return '';
  if (stringWidth(text) <= size) return text;
  const available = size - stringWidth('…');
  let result = '';
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    if (stringWidth(result + segment) > available) break;
    result += segment;
  }
  return `${result}…`;
}
