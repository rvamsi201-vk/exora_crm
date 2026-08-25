/**
 * Small, dependency-free string similarity used to flag likely-duplicate
 * company names that don't match exactly (e.g. "Sunrise School" vs
 * "Sunrise Public School"). Not used for anything but review-queue scoring.
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

// 1.0 = identical, 0.0 = completely different.
function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

module.exports = { levenshtein, nameSimilarity };
