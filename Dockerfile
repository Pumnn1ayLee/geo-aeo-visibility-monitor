FROM node:22-alpine

WORKDIR /usr/src/app
COPY package.json ./
COPY src ./src
COPY examples ./examples

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
