FROM node:26-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --chown=node:node server.js .
RUN mkdir -p /opt/context-gateway/data /run/getbased-verifier \
    && chown -R node:node /opt/context-gateway /run/getbased-verifier
EXPOSE 4001
USER node
CMD ["node", "server.js"]
