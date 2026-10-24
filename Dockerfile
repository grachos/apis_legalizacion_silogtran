FROM node:20-slim
# Chromium is only used to solve the AWS WAF challenge in front of Silogtran.
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production WAF_CHROME_PATH=/usr/bin/chromium NODE_OPTIONS=--max-old-space-size=400
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
