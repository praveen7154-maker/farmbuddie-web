FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 4000

CMD ["node", "src/index.js"]
