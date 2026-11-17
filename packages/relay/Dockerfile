FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public

ENV PORT=7801
EXPOSE 7801
CMD ["node", "server.js"]
