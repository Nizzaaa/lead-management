# LeadPilot – Lead-Verwaltung mit KI
FROM node:22-alpine

# Arbeitsverzeichnis
WORKDIR /app

# Nur Manifeste kopieren → bessere Layer-Caches beim Neu-Bauen
COPY package.json package-lock.json ./

# Nur Produktionsabhängigkeiten installieren
RUN npm ci --omit=dev

# Anwendungscode kopieren
COPY server.js db.js research.js prompts.js logger.js exporters.js cfAccess.js caldav.js ./
COPY public ./public

# Als unprivilegierter Node-Benutzer laufen
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Einfacher Healthcheck gegen die Config-Route
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/config',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
