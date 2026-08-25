const serper = require('./serper');
const website = require('./website');
const csv = require('./csv');
const manual = require('./manual');

const REGISTRY = { serper, website, csv, manual };

function getCollector(sourceType) {
  const collector = REGISTRY[sourceType];
  if (!collector) throw new Error(`Unknown source_type: ${sourceType}`);
  return collector;
}

module.exports = { getCollector, REGISTRY };
