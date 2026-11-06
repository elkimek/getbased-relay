FROM node:24.22.1-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:24.22.1-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

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
