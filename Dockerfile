FROM node:20-bookworm-slim

# Install modern Chromium, certs, and font dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
    procps \
    libnss3 \
    && rm -rf /var/lib/apt/lists/*

# Point Puppeteer directly to Debian's installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "--max-old-space-size=200", "server.js"]