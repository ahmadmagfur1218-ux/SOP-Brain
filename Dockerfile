FROM node:22-alpine

WORKDIR /app

# Install all dependencies (including tsx & vite for build + runtime)
COPY package.json ./
RUN npm install --include=dev

# Copy application source
COPY . .

# Build frontend SPA bundle into /app/dist
RUN npm run build && mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npx", "tsx", "server.ts"]
