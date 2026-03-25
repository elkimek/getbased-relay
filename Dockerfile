FROM node:22-slim

# better-sqlite3 needs build tools for native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY . .

RUN mkdir -p /data
ENV DATA_DIR=/data
ENV NODE_ENV=production

EXPOSE 4000 4001
USER node
CMD ["node", "index.js"]
