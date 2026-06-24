FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js .
RUN mkdir -p /opt/context-gateway/data /data
EXPOSE 4001
CMD ["node", "server.js"]
