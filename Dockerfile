FROM node:26.9.0-slim@sha256:3a771f83944bb763050c23c0225c260638c4b7899e7a72485ef75e5e570499e5 AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:26.9.0-slim@sha256:3a771f83944bb763050c23c0225c260638c4b7899e7a72485ef75e5e570499e5

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && rm -rf /root/.npm
COPY --from=builder /app/dist dist/

RUN mkdir -p /data /run/getbased-verifier \
    && chown node:node /data /run/getbased-verifier
ENV DATA_DIR=/data
ENV NODE_ENV=production

EXPOSE 4000 4001 4002 4003
USER node
CMD ["node", "dist/index.js"]
