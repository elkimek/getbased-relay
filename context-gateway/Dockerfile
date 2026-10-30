FROM node:24.22.0-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --chown=node:node server.js .
RUN mkdir -p /opt/context-gateway/data /run/getbased-verifier \
    && chown -R node:node /opt/context-gateway /run/getbased-verifier
EXPOSE 4001
USER node
CMD ["node", "server.js"]
