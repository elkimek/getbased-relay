FROM node:26.8.1-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:26.8.1-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146

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
