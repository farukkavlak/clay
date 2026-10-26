/** Grapheme clusters, so an accented letter or a multi-code-point emoji counts as one. */
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function charactersOf(text: string): string[] {
  return [...graphemes.segment(text)].map(({ segment }) => segment);
}
