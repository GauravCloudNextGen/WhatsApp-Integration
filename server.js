const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const util = require('util');

const app = express();
const PORT = process.env.PORT || 3000;

// Your active Salesforce Experience Site REST Endpoint for Task testing
const SALESFORCE_WEBHOOK_URL = 'https://cloudnextgen7-dev-ed.develop.my.site.com/vendor360/services/apexrest/whatsapp/task-test/';
const CONFIG_FILE = path.join(__dirname, 'config.json');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let currentQrDataUrl = null;
let isClientReady = false;
let groupMap = new Map(); // id -> name
let monitoredGroupIds = new Set();

function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            monitoredGroupIds = new Set(data.monitoredGroupIds || []);
            if (Array.isArray(data.savedGroups)) {
                data.savedGroups.forEach(g => {
                    if (g.id && g.name) groupMap.set(g.id, g.name);
                });
            }
            console.log(`[Config] Loaded ${monitoredGroupIds.size} monitored group(s).`);
        } catch (e) {
            console.error('[Config Error]:', e.message);
        }
    }
}

function saveConfig() {
    const savedGroups = Array.from(groupMap.entries()).map(([id, name]) => ({ id, name }));
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
        monitoredGroupIds: Array.from(monitoredGroupIds),
        savedGroups: savedGroups
    }, null, 2));
}

loadConfig();

async function syncRealWhatsAppGroups() {
    if (!client || !isClientReady || !client.pupPage) return [];

    try {
        console.log('\n--- [FETCHING GROUPS ONLY] ---');
        const foundGroups = await client.pupPage.evaluate(async () => {
            const extracted = [];
            const seen = new Set();

            const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
            const groupFilter = buttons.find(b => (b.innerText || '').trim().toLowerCase() === 'groups');
            if (groupFilter) {
                groupFilter.click();
                await new Promise(r => setTimeout(r, 1000));
            }

            const titleNodes = document.querySelectorAll(
                '#pane-side div[data-testid="cell-frame-title"] span[title], ' +
                '#pane-side span[data-testid="conversation-info-header"] span[title]'
            );

            titleNodes.forEach(node => {
                const title = node.getAttribute('title');
                if (title && title.trim().length > 0 && !seen.has(title)) {
                    seen.add(title);
                    extracted.push({
                        name: title,
                        id: `group_${encodeURIComponent(title)}`
                    });
                }
            });
            return extracted;
        });

        console.log(`[Sync Result] Found ${foundGroups.length} group(s).`);
        foundGroups.forEach(g => {
            groupMap.set(g.id, g.name);
        });

        saveConfig();
        console.log('--- [SYNC COMPLETE] ---\n');
        return foundGroups;
    } catch (err) {
        console.error('[Sync Error]:', err.message);
        return [];
    }
}

// Client configured strictly for sub-512MB RAM constraints
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './wwebjs_auth' }),
    puppeteer: {
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        defaultViewport: { width: 800, height: 600 }, // Minimal viewport keeps rendering buffers tiny
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--mute-audio',
            '--disable-accelerated-2d-canvas',
            '--no-default-browser-check',
            '--disable-component-update',
            '--js-flags="--max-old-space-size=180 --optimize-for-size"'
        ]
    }
});

// Intercept requests and block media assets to cut RAM usage in half
client.on('ready', async () => {
    isClientReady = true;
    currentQrDataUrl = null;
    console.log('\n======================================================');
    console.log('>>> WhatsApp Connected (Low-Memory Mode) <<<');
    console.log(`Endpoint: ${SALESFORCE_WEBHOOK_URL}`);
    console.log('======================================================\n');

    try {
        if (client.pupPage) {
            await client.pupPage.setRequestInterception(true);
            client.pupPage.on('request', (req) => {
                const resourceType = req.resourceType();
                // Block heavy static assets; allow only scripts and websocket connections
                if (['image', 'media', 'font'].includes(resourceType)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });
        }
    } catch (e) {
        console.log('[Media Optimizer Notice] Request interception already set or skipped.');
    }

    setTimeout(async () => {
        await syncRealWhatsAppGroups();
    }, 3500);
});

client.on('qr', async (qr) => {
    isClientReady = false;
    currentQrDataUrl = await QRCode.toDataURL(qr);
    console.log('\n[QR] Scan QR code from http://localhost:3000 or terminal:\n');
    qrcodeTerminal.generate(qr, { small: true });
});

// Incoming message listener
client.on('message', async (msg) => {
    try {
        if (!msg || !msg.body || msg.body.trim().length === 0) return;

        let groupTitle = 'Direct Message';
        let rawId = msg.from || '';

        try {
            const chat = await msg.getChat();
            if (chat) {
                groupTitle = chat.name || chat.formattedTitle || 'WhatsApp Group';
                rawId = chat.id?._serialized || msg.from;
            }
        } catch (e) {
            rawId = msg.from || '';
            groupTitle = rawId.endsWith('@g.us') ? 'Group Chat' : 'Direct Message';
        }

        const sender = msg._data?.notifyName || msg.author || msg.from || 'Member';
        const cleanTitle = groupTitle.toLowerCase().replace(/[^a-z0-9]/g, '');

        let isMonitored = monitoredGroupIds.has(rawId) || 
                          monitoredGroupIds.has(`group_${encodeURIComponent(groupTitle)}`) ||
                          cleanTitle.includes('fresherjobs') ||
                          monitoredGroupIds.size === 0;

        if (isMonitored) {
            console.log(`\n[DISPATCHING] "${groupTitle}" | Sender: ${sender}`);

            const payload = {
                body: msg.body,
                senderName: sender,
                chatId: rawId || `group_${encodeURIComponent(groupTitle)}`,
                groupName: groupTitle
            };

            const response = await axios({
                method: 'POST',
                url: SALESFORCE_WEBHOOK_URL,
                data: payload,
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000
            });

            console.log('-> Created Task in Salesforce! ID:', response.data?.recordId || response.data?.taskId || 'OK');
        }
    } catch (err) {
        console.error('\n--- [DISPATCH ERROR] ---');
        if (err.response) {
            console.error(`Status: ${err.response.status} - Data:`, util.inspect(err.response.data));
        } else {
            console.error('Error:', err.message);
        }
        console.error('------------------------\n');
    }
});

client.initialize();

// Dashboard UI
app.get('/', async (req, res) => {
    const allGroups = Array.from(groupMap.entries()).map(([id, name]) => ({ id, name }));
    let html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>WhatsApp VMS Gateway</title>
        <style>
            * { box-sizing: border-box; font-family: sans-serif; }
            body { background: #f1f5f9; padding: 2rem; display: flex; justify-content: center; }
            .card { background: #fff; max-width: 600px; width: 100%; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
            .btn { background: #0284c7; color: #fff; padding: 10px 16px; border: none; border-radius: 4px; cursor: pointer; text-decoration: none; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>WhatsApp VMS Gateway (${isClientReady ? '<span style="color:green">Connected</span>' : '<span style="color:orange">Awaiting QR Scan</span>'})</h2>
    `;

    if (!isClientReady) {
        html += `
            <div style="text-align:center; padding: 1rem;">
                <p>Scan with WhatsApp (Linked Devices):</p>
                ${currentQrDataUrl ? `<img src="${currentQrDataUrl}" style="width:200px" />` : '<p>Generating QR Code...</p>'}
            </div>
        `;
    } else {
        html += `
            <form action="/save-groups" method="POST">
                <p>Select target groups:</p>
                <div style="max-height: 250px; overflow-y:auto; border:1px solid #ddd; padding: 8px; margin-bottom: 1rem;">
        `;
        allGroups.forEach(g => {
            const isChecked = monitoredGroupIds.has(g.id) || g.name.toLowerCase().includes('fresher') ? 'checked' : '';
            html += `
                <div style="padding: 6px 0; border-bottom:1px solid #eee;">
                    <input type="checkbox" name="selectedGroups" value="${g.id}" ${isChecked} />
                    <strong>${g.name}</strong>
                </div>
            `;
        });
        html += `
                </div>
                <button type="submit" class="btn">Save Selection</button>
                <a href="/force-sync" class="btn" style="background:#64748b;">Refresh Groups</a>
            </form>
        `;
    }

    html += `</div></body></html>`;
    res.send(html);
});

app.get('/force-sync', async (req, res) => {
    await syncRealWhatsAppGroups();
    res.redirect('/');
});

app.post('/save-groups', (req, res) => {
    const selected = req.body.selectedGroups;
    monitoredGroupIds.clear();
    if (Array.isArray(selected)) {
        selected.forEach(id => monitoredGroupIds.add(id));
    } else if (typeof selected === 'string') {
        monitoredGroupIds.add(selected);
    }
    saveConfig();
    res.redirect('/');
});

app.listen(PORT, () => {
    console.log(`Gateway listening on port ${PORT}`);
});