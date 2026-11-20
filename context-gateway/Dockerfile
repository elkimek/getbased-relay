FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --chown=node:node server.js .
RUN mkdir -p /opt/context-gateway/data /run/getbased-verifier \
    && chown -R node:node /opt/context-gateway /run/getbased-verifier
EXPOSE 4001
USER node
CMD ["node", "server.js"]
