const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const util = require('util');

const app = express();
const PORT = 3000;

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

// Strictly extract only Group titles, never message previews or text snippets
async function syncRealWhatsAppGroups() {
    if (!client || !isClientReady || !client.pupPage) {
        console.log('[Sync Notice] WhatsApp client is not fully ready yet.');
        return [];
    }

    try {
        console.log('\n--- [FETCHING GROUPS ONLY] ---');

        const foundGroups = await client.pupPage.evaluate(async () => {
            const extracted = [];
            const seen = new Set();

            // 1. Click "Groups" filter button if present to hide individual chats
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
            const groupFilter = buttons.find(b => (b.innerText || '').trim().toLowerCase() === 'groups');
            if (groupFilter) {
                groupFilter.click();
                await new Promise(r => setTimeout(r, 1200));
            }

            // 2. Target strictly the primary title line of chat cells
            const titleNodes = document.querySelectorAll(
                '#pane-side div[data-testid="cell-frame-title"] span[title], ' +
                '#pane-side span[data-testid="conversation-info-header"] span[title]'
            );

            titleNodes.forEach(node => {
                const title = node.getAttribute('title');
                
                if (title && title.trim().length > 0 && !seen.has(title)) {
                    seen.add(title);

                    let realId = '';
                    const cell = node.closest('div[tabindex="-1"]') || node.closest('div[role="row"]') || node.closest('div[data-testid="cell-frame-container"]');
                    if (cell) {
                        const fiberKey = Object.keys(cell).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
                        if (fiberKey && cell[fiberKey]) {
                            let curr = cell[fiberKey];
                            while (curr && !realId) {
                                const idCandidate = curr.memoizedProps?.chat?.id?._serialized;
                                if (idCandidate) {
                                    realId = idCandidate;
                                }
                                curr = curr.return;
                            }
                        }
                    }

                    extracted.push({
                        name: title,
                        id: realId || `group_${encodeURIComponent(title)}`
                    });
                }
            });

            return extracted;
        });

        console.log(`[Sync Result] Found ${foundGroups.length} group(s):`);
        foundGroups.forEach(g => {
            groupMap.set(g.id, g.name);
            console.log(` - Group: "${g.name}"`);
        });

        saveConfig();
        console.log('--- [SYNC COMPLETE] ---\n');
        return foundGroups;

    } catch (err) {
        console.error('[Sync Error]:', err.message);
        return [];
    }
}

// Client initialization with explicit viewport for complete chat rendering
// Client initialization with persistent auth storage and cloud Puppeteer binary support
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './wwebjs_auth' }),
    puppeteer: {
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        defaultViewport: { width: 1440, height: 900 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-zygote'
        ]
    }
});

// Print QR code directly in the terminal AND save image for Web UI
client.on('qr', async (qr) => {
    isClientReady = false;
    currentQrDataUrl = await QRCode.toDataURL(qr);

    console.log('\n======================================================');
    console.log('>>> SCAN THIS QR CODE IN WHATSAPP (LINKED DEVICES) <<<');
    console.log('======================================================\n');
    qrcodeTerminal.generate(qr, { small: true });
    console.log('\nOr open http://localhost:3000 in your browser to view the QR code.\n');
});

client.on('ready', async () => {
    isClientReady = true;
    currentQrDataUrl = null;
    console.log('\n======================================================');
    console.log('>>> WhatsApp Connected Successfully! <<<');
    console.log(`Endpoint: ${SALESFORCE_WEBHOOK_URL}`);
    console.log('======================================================\n');

    setTimeout(async () => {
        await syncRealWhatsAppGroups();
    }, 3500);
});

// Incoming message listener: dispatches to Salesforce
client.on('message', async (msg) => {
    try {
        if (!msg || !msg.body || msg.body.trim().length === 0) return;

        // Resolve chat details safely without crashing if getChat() rejects
        let groupTitle = 'Direct Message';
        let rawId = msg.from || '';

        try {
            const chat = await msg.getChat();
            if (chat) {
                groupTitle = chat.name || chat.formattedTitle || 'WhatsApp Group';
                rawId = chat.id?._serialized || msg.from;
            }
        } catch (e) {
            // Fallback to internal payload properties
            rawId = msg.from || '';
            groupTitle = rawId.endsWith('@g.us') ? 'Group Chat' : 'Direct Message';
        }

        const sender = msg._data?.notifyName || msg.author || msg.from || 'Member';
        const cleanTitle = groupTitle.toLowerCase().replace(/[^a-z0-9]/g, '');

        // Match if monitored, or name contains fresher jobs, or during open testing
        let isMonitored = monitoredGroupIds.has(rawId) || 
                          monitoredGroupIds.has(`group_${encodeURIComponent(groupTitle)}`) ||
                          cleanTitle.includes('fresherjobs') ||
                          monitoredGroupIds.size === 0;

        if (isMonitored) {
            console.log(`\n======================================================`);
            console.log(`[MESSAGE DETECTED -> DISPATCHING TO SALESFORCE]`);
            console.log(`Group  : ${groupTitle}`);
            console.log(`Sender : ${sender}`);
            console.log(`Text   : ${msg.body.substring(0, 90)}...`);
            console.log(`======================================================\n`);

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
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 15000
            });

            console.log('-> Salesforce Task Created Successfully! Response:', response.data, '\n');
        }
    } catch (err) {
        console.error('\n--- [DETAILED DISPATCH ERROR] ---');
        if (err.response) {
            console.error(`HTTP Status: ${err.response.status} (${err.response.statusText})`);
            console.error('Response Data:', util.inspect(err.response.data, { depth: null, colors: true }));
        } else if (err.request) {
            console.error('No response received from Salesforce (Check connection/timeout):', err.code || err.message);
        } else {
            console.error('Execution Error:', util.inspect(err, { depth: 3, colors: true }));
        }
        console.error('--------------------------------\n');
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
            * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
            body { background: #f8fafc; margin: 0; padding: 2rem; display: flex; justify-content: center; }
            .container { background: #ffffff; max-width: 680px; width: 100%; border-radius: 12px; padding: 2rem; box-shadow: 0 4px 16px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }
            h1 { font-size: 1.3rem; color: #0f172a; margin: 0 0 1rem 0; display: flex; justify-content: space-between; align-items: center; }
            .badge { padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; }
            .badge-ready { background: #ecfdf5; color: #047857; }
            .badge-qr { background: #fef3c7; color: #b45309; }
            .qr-box { text-align: center; padding: 2rem 1rem; border: 2px dashed #cbd5e1; border-radius: 12px; margin: 1.5rem 0; }
            .qr-box img { width: 220px; height: 220px; }
            .group-list { max-height: 360px; overflow-y: auto; border: 1px solid #e2e8f0; border-radius: 8px; margin: 1rem 0; padding: 0.5rem; background: #fafafa; }
            .group-item { display: flex; align-items: center; gap: 12px; padding: 0.85rem; border-bottom: 1px solid #f1f5f9; background: #fff; margin-bottom: 4px; border-radius: 6px; }
            .group-title { font-size: 0.95rem; font-weight: 700; color: #1e293b; display: flex; align-items: center; gap: 8px; }
            .verified-tag { font-size: 0.7rem; background: #dcfce7; color: #15803d; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
            .group-id-sub { font-size: 0.72rem; color: #64748b; font-family: monospace; margin-top: 3px; }
            .btn-row { display: flex; gap: 10px; margin-top: 1rem; }
            .save-btn { background: #0284c7; color: #ffffff; border: none; padding: 12px 20px; border-radius: 8px; font-weight: 700; cursor: pointer; flex-grow: 1; font-size: 0.95rem; }
            .save-btn:hover { background: #0369a1; }
            .sync-btn { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; padding: 12px 18px; border-radius: 8px; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
            .sync-btn:hover { background: #e2e8f0; }
            .del-btn { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; padding: 6px 10px; border-radius: 6px; font-size: 0.75rem; font-weight: 700; text-decoration: none; margin-left: auto; }
            .count-pill { background: #e0f2fe; color: #0284c7; font-size: 0.8rem; font-weight: 700; padding: 3px 10px; border-radius: 12px; }
        </style>
        <script>
            ${!isClientReady ? 'setTimeout(() => location.reload(), 3000);' : ''}
        </script>
    </head>
    <body>
        <div class="container">
            <h1>
                <span>WhatsApp Group Selector</span>
                ${isClientReady 
                    ? '<span class="badge badge-ready">Connected</span>' 
                    : '<span class="badge badge-qr">Awaiting Scan</span>'}
            </h1>
    `;

    if (!isClientReady) {
        html += `
            <div class="qr-box">
                <p><strong>Scan QR Code to Link WhatsApp</strong><br><span style="font-size:0.8rem;color:#64748b">Check your terminal or scan the image below:</span></p>
                ${currentQrDataUrl ? `<img src="${currentQrDataUrl}" alt="Scan QR Code" />` : '<p>Generating QR Code... Please check PowerShell terminal.</p>'}
            </div>
        `;
    } else {
        html += `
            <p style="font-size:0.85rem; color:#475569; margin:0 0 1rem 0;">
                Select groups to monitor. Messages will create <strong>Task</strong> records in Salesforce.
            </p>

            <form action="/save-groups" method="POST">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
                    <span style="font-size:0.85rem; font-weight:700; color:#334155;">Detected Chats (${allGroups.length}):</span>
                    <span class="count-pill">${monitoredGroupIds.size} Monitored</span>
                </div>

                <div class="group-list">
        `;

        if (allGroups.length === 0) {
            html += `
                <div style="padding: 2rem; text-align: center; color: #64748b; font-size:0.9rem;">
                    <p style="margin:0 0 10px 0; font-weight:600;">Groups are loading...</p>
                    <a href="/force-sync" class="sync-btn" style="display:inline-block;">↻ Refresh & Sync Groups</a>
                </div>
            `;
        } else {
            allGroups.forEach(g => {
                const isChecked = monitoredGroupIds.has(g.id) || g.name.toLowerCase().includes('fresher') ? 'checked' : '';
                html += `
                    <div class="group-item">
                        <input type="checkbox" name="selectedGroups" value="${g.id}" ${isChecked} style="cursor:pointer;" />
                        <div style="flex-grow:1; margin-left:8px;">
                            <div class="group-title">
                                ${g.name}
                                <span class="verified-tag">✔ Detected</span>
                            </div>
                            <div class="group-id-sub">${g.id}</div>
                        </div>
                        <a href="/delete-group?id=${encodeURIComponent(g.id)}" class="del-btn" title="Remove">✕</a>
                    </div>
                `;
            });
        }

        html += `
                </div>
                <div class="btn-row">
                    <button type="submit" class="save-btn">Save Active Monitoring Groups</button>
                    <a href="/force-sync" class="sync-btn">↻ Refresh & Sync</a>
                </div>
            </form>
        `;
    }

    html += `
        </div>
    </body>
    </html>
    `;

    res.send(html);
});

app.get('/force-sync', async (req, res) => {
    await syncRealWhatsAppGroups();
    res.redirect('/');
});

app.get('/delete-group', (req, res) => {
    const id = req.query.id;
    if (id) {
        groupMap.delete(id);
        monitoredGroupIds.delete(id);
        saveConfig();
    }
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
    console.log(`[Config Saved] Actively monitoring ${monitoredGroupIds.size} group(s).`);
    res.redirect('/');
});

app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`  Gateway Selector Ready: http://localhost:${PORT}`);
    console.log(`======================================================\n`);
});
