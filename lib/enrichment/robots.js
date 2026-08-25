/**
 * Minimal robots.txt parser: reads only the `User-agent: *` block's
 * `Disallow:` rules. Good enough to respect a site's basic opt-out without
 * pulling in a full robots.txt library for one lookup per crawl.
 */
function parseRobots(text) {
  const disallow = [];
  let inWildcardBlock = false;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      inWildcardBlock = value === '*';
    } else if (key === 'disallow' && inWildcardBlock && value) {
      disallow.push(value);
    }
  }
  return { disallow };
}

function isPathAllowed(rules, path) {
  return !rules.disallow.some((rule) => path.startsWith(rule));
}

module.exports = { parseRobots, isPathAllowed };
