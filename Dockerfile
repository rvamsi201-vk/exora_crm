# Exora CRM / LeadFlow (crm.exora.solutions)
FROM node:20-bookworm-slim
# sqlite3 CLI: used by scripts/sync-nomi-users.sh to read Nomi's users (read-only)
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
# puppeteer is listed in package.json but no code launches a browser: skip the ~300 MB Chrome download
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .
ENV HOST=0.0.0.0
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
