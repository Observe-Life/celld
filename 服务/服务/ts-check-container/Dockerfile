FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm i --registry=https://registry.npmmirror.com --silent
COPY server.js ./
EXPOSE 8080
CMD ["node", "server.js"]
