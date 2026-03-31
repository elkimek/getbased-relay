FROM node:22-slim
WORKDIR /app
COPY server.js .
RUN mkdir -p /opt/context-gateway/data
EXPOSE 4001
CMD ["node", "server.js"]
