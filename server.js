const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const util = require('util');

const app = express();
const PORT = process.env.PORT || 3000;

// Salesforce REST Webhook Endpoint
const SALESFORCE_WEBHOOK_URL = 'https://cloudnextgen7-dev-ed.develop.my.site.com/vendor360/services/apexrest/whatsapp/task-test/';
const CONFIG_FILE = path.join(__dirname, 'config.json');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock = null;
let currentQrDataUrl = null;
let isClientReady = false;
let groupMap = new Map(); // JID -> Subject/Name
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

// Directly fetch real groups via WhatsApp socket (instant, zero memory overhead)
async function syncRealWhatsAppGroups() {
    if (!sock || !isClientReady) return [];

    try {
        console.log('\n--- [FETCHING GROUPS VIA BAILEYS] ---');
        const groups = await sock.groupFetchAllParticipating();
        
        for (const jid in groups) {
            const meta = groups[jid];
            groupMap.set(jid, meta.subject || 'Unnamed Group');
        }

        console.log(`[Sync Result] Found ${groupMap.size} group(s):`);
        groupMap.forEach((name, id) => {
            console.log(` - "${name}" (${id})`);
        });

        saveConfig();
        console.log('--- [SYNC COMPLETE] ---\n');
        return Array.from(groupMap.entries()).map(([id, name]) => ({ id, name }));
    } catch (err) {
        console.error('[Sync Error]:', err.message);
        return [];
    }
}

// Start Baileys WebSocket Client
async function startWhatsAppSocket() {
    const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), // Suppress noisy protocol logs
        auth: state,
        printQRInTerminal: false,
        browser: ['VMS Gateway', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            isClientReady = false;
            currentQrDataUrl = await QRCode.toDataURL(qr);
            console.log('\n======================================================');
            console.log('>>> SCAN THIS QR CODE IN WHATSAPP (LINKED DEVICES) <<<');
            console.log('======================================================\n');
            qrcodeTerminal.generate(qr, { small: true });
            console.log('\nOr open http://localhost:3000 in your browser to view the QR code.\n');
        }

        if (connection === 'close') {
            isClientReady = false;
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[Connection Closed] Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(startWhatsAppSocket, 3000);
            } else {
                console.log('Session logged out. Delete baileys_auth folder and scan again.');
            }
        } else if (connection === 'open') {
            isClientReady = true;
            currentQrDataUrl = null;
            console.log('\n======================================================');
            console.log('>>> WhatsApp Connected Successfully (Baileys Light)! <<<');
            console.log(`Endpoint: ${SALESFORCE_WEBHOOK_URL}`);
            console.log('======================================================\n');

            setTimeout(syncRealWhatsAppGroups, 2000);
        }
    });

    // Listen for incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;

                const remoteJid = msg.key.remoteJid || '';
                const isGroup = remoteJid.endsWith('@g.us');

                // Extract text content across standard text and extended preview messages
                const messageText = msg.message.conversation || 
                                    msg.message.extendedTextMessage?.text || 
                                    msg.message.imageMessage?.caption || 
                                    '';

                if (!messageText.trim()) continue;

                // Determine Group Name
                let groupName = 'Direct Message';
                if (isGroup) {
                    groupName = groupMap.get(remoteJid);
                    if (!groupName) {
                        try {
                            const meta = await sock.groupMetadata(remoteJid);
                            groupName = meta.subject;
                            groupMap.set(remoteJid, groupName);
                        } catch {
                            groupName = 'WhatsApp Group';
                        }
                    }
                }

                const senderName = msg.pushName || msg.key.participant?.split('@')[0] || 'Member';
                const cleanTitle = groupName.toLowerCase().replace(/[^a-z0-9]/g, '');

                // Check monitoring criteria
                const isMonitored = monitoredGroupIds.has(remoteJid) ||
                                    cleanTitle.includes('fresherjobs') ||
                                    monitoredGroupIds.size === 0;

                if (isMonitored) {
                    console.log(`\n======================================================`);
                    console.log(`[MESSAGE DETECTED -> DISPATCHING TO SALESFORCE]`);
                    console.log(`Group  : ${groupName} (${remoteJid})`);
                    console.log(`Sender : ${senderName}`);
                    console.log(`Text   : ${messageText.substring(0, 90)}...`);
                    console.log(`======================================================\n`);

                    const payload = {
                        body: messageText,
                        senderName: senderName,
                        chatId: remoteJid,
                        groupName: groupName
                    };

                    const response = await axios.post(SALESFORCE_WEBHOOK_URL, payload, {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 15000
                    });

                    console.log('-> Salesforce Record Created! ID:', response.data?.recordId || response.data?.taskId || 'OK', '\n');
                }
            }
        } catch (err) {
            console.error('\n--- [DISPATCH ERROR] ---');
            if (err.response) {
                console.error(`Status: ${err.response.status} -`, util.inspect(err.response.data));
            } else {
                console.error('Error:', err.message);
            }
            console.error('------------------------\n');
        }
    });
}

startWhatsAppSocket();

// Web Selector UI
app.get('/', (req, res) => {
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
            .btn-row { display: flex; gap: 10px; margin-top: 1rem; }
            .save-btn { background: #0284c7; color: #ffffff; border: none; padding: 12px 20px; border-radius: 8px; font-weight: 700; cursor: pointer; flex-grow: 1; }
            .sync-btn { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; padding: 12px 18px; border-radius: 8px; font-weight: 700; text-decoration: none; }
        </style>
        <script>${!isClientReady ? 'setTimeout(() => location.reload(), 3000);' : ''}</script>
    </head>
    <body>
        <div class="container">
            <h1>
                <span>WhatsApp VMS Gateway (Ultra-Light)</span>
                ${isClientReady 
                    ? '<span class="badge badge-ready">Connected</span>' 
                    : '<span class="badge badge-qr">Awaiting Scan</span>'}
            </h1>
    `;

    if (!isClientReady) {
        html += `
            <div class="qr-box">
                <p><strong>Scan QR Code in WhatsApp</strong><br><span style="font-size:0.8rem;color:#64748b">Terminal or image below:</span></p>
                ${currentQrDataUrl ? `<img src="${currentQrDataUrl}" alt="Scan QR Code" />` : '<p>Generating QR Code...</p>'}
            </div>
        `;
    } else {
        html += `
            <form action="/save-groups" method="POST">
                <div style="margin-bottom: 10px; font-weight: 600;">Monitored Groups:</div>
                <div class="group-list">
        `;
        allGroups.forEach(g => {
            const isChecked = monitoredGroupIds.has(g.id) || g.name.toLowerCase().includes('fresher') ? 'checked' : '';
            html += `
                <div class="group-item">
                    <input type="checkbox" name="selectedGroups" value="${g.id}" ${isChecked} />
                    <div>
                        <div style="font-weight: 700;">${g.name}</div>
                        <div style="font-size:0.75rem; color:#64748b;">${g.id}</div>
                    </div>
                </div>
            `;
        });
        html += `
                </div>
                <div class="btn-row">
                    <button type="submit" class="save-btn">Save Active Monitoring Groups</button>
                    <a href="/force-sync" class="sync-btn">↻ Refresh Groups</a>
                </div>
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
    console.log(`[Config Saved] Actively monitoring ${monitoredGroupIds.size} group(s).`);
    res.redirect('/');
});

app.listen(PORT, () => {
    console.log(`Gateway Ready on port ${PORT}`);
});