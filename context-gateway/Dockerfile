FROM node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --chown=node:node server.js .
RUN mkdir -p /opt/context-gateway/data /run/getbased-verifier \
    && chown -R node:node /opt/context-gateway /run/getbased-verifier
EXPOSE 4001
USER node
CMD ["node", "server.js"]
