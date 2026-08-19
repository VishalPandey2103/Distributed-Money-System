FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
# Migrations must run before serving, but we run them inline at startup
# because each node's Postgres is a different DB.
CMD ["sh", "-c", "node scripts/migrate.js && node src/server.js"]
