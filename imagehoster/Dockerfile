FROM node:8

RUN npm install -g yarn

WORKDIR /usr/src/app
COPY . .

RUN yarn install --production --non-interactive --pure-lockfile

ENV NODE_ENV production
EXPOSE 80

CMD ["yarn", "run", "start"]
