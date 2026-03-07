FROM node:23-slim AS builder

WORKDIR /app
COPY . .

WORKDIR /app/res
RUN npm install


FROM node:23-slim

WORKDIR /app/res

COPY --from=builder /app/res /app/res

CMD ["node","server.js"]
