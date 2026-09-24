FROM node:18-bullseye-slim

# Install latest Chromium and required OS dependencies
RUN apt-get update \
    && apt-get install -y wget gnupg ca-certificates procps libxss1 chromium fonts-ipafont-gothic fonts-freefont-ttf fonts-kacst fonts-thai-tlwg \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer executable path to the installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]