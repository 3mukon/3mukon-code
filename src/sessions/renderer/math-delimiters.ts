// A message's math in the delimiters remark-math reads, as models write it in several: \(…\) becomes
// $…$ and \[…\] a $$ block of its own. A single dollar counts as math only by Pandoc's rules, which
// leave prices and shell variables in prose as they are: a pair on one line whose opening dollar is
// followed by something other than a space, and whose closing dollar follows something other than a
// space and is followed by no digit. Any other dollar is escaped. Code, fenced or inline, stays as it
// is.
export function withMathDelimiters(text: string): string {
  return text
    .split(/(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]*`)/)
    .map((part, index) => (index % 2 === 1 ? part : delimited(part)))
    .join('');
}

function delimited(prose: string): string {
  return prose
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, math: string) => `$${math.trim()}$`)
    .replace(/\\\$|\$\$[\s\S]+?\$\$|\$(?=\S)[^$\n]*?[^\s\\$]\$(?!\d)|\$/g, (found) =>
      found === '$' ? '\\$' : found,
    );
}
