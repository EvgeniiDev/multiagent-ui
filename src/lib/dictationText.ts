/** A partial is a snapshot: committed prefix + replaceable hypothesis tail. */
export function transcriptSeparator(left: string, right: string): string {
  return left && right && !/\s$/.test(left) && !/^\s/.test(right) ? ' ' : '';
}

export function insertDictation(value: string, at: number, text: string) {
  const before = value.slice(0, at);
  const after = value.slice(at);
  const spoken = text.trim();
  if (!spoken) return { value, caret: at };
  const insert = transcriptSeparator(before, spoken) + spoken + transcriptSeparator(spoken, after);
  return { value: before + insert + after, caret: before.length + insert.length };
}

/** Keep the insertion point attached to typed text when the user edits it. */
export function moveDictationAnchor(before: string, after: string, at: number): number {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let suffix = 0;
  while (suffix < before.length - start && suffix < after.length - start
      && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  if (oldEnd <= at) return at + after.length - before.length;
  if (start < at) return newEnd;
  return at;
}
