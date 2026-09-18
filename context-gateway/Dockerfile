FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --chown=node:node server.js .
RUN mkdir -p /opt/context-gateway/data /run/getbased-verifier \
    && chown -R node:node /opt/context-gateway /run/getbased-verifier
EXPOSE 4001
USER node
CMD ["node", "server.js"]
