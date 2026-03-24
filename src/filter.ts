// clooks filter engine — keyword-based handler filtering

/**
 * Evaluate a keyword filter against input text.
 *
 * Filter syntax:
 *   "word1|word2|word3"  — match if ANY keyword found (OR)
 *   "!word"              — exclude if keyword found (NOT)
 *   Mixed: "word1|word2|!word3" — match word1 OR word2, but NOT if word3 present
 *
 * Returns true if handler should execute, false if filtered out.
 */
export function evaluateFilter(filter: string, input: string): boolean {
  const terms = filter.split('|').map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return true;

  const positive: string[] = [];
  const negative: string[] = [];

  for (const term of terms) {
    if (term.startsWith('!')) {
      negative.push(term.slice(1));
    } else {
      positive.push(term);
    }
  }

  const lowerInput = input.toLowerCase();

  // If ANY negative term is found → blocked
  for (const neg of negative) {
    if (lowerInput.includes(neg.toLowerCase())) {
      return false;
    }
  }

  // If there are positive terms, at least ONE must match
  if (positive.length > 0) {
    return positive.some((pos) => lowerInput.includes(pos.toLowerCase()));
  }

  // Only negative terms and none matched → allow
  return true;
}
