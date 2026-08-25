function databaseSslConfig() {
  const mode = (process.env.DATABASE_SSL_MODE || 'require').toLowerCase();
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}

module.exports = { databaseSslConfig };
