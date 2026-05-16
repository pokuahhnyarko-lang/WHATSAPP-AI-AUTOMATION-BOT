const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// ===================== CONFIGURATION =====================
const PORT = process.env.PORT || 3000;
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');

// Ensure session directory exists
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// ===================== EXPRESS SETUP =====================
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ===================== WHATSAPP CLIENT =====================
let client = null;
let clientStatus = 'disconnected';
let pairingCode = null;

function createClient() {
    if (client) {
        client.destroy().catch(() => {});
    }

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'wabot-session',
            dataPath: SESSION_DIR
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ]
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        }
    });

    client.on('qr', async (qr) => {
        clientStatus = 'awaiting_scan';
        try {
            const qrImage = await qrcode.toDataURL(qr);
            io.emit('qr_code', { image: qrImage, type: 'qr' });
            io.emit('status_update', { status: 'awaiting_scan', message: 'Scan QR code with WhatsApp' });
        } catch (err) {
            console.error('QR generation error:', err);
        }
    });

    client.on('ready', () => {
        clientStatus = 'connected';
        io.emit('status_update', { status: 'connected', message: 'WhatsApp connected successfully!' });
        io.emit('qr_code', { image: null, type: 'none' });
        console.log('WhatsApp client is ready!');
    });

    client.on('authenticated', () => {
        clientStatus = 'authenticated';
        io.emit('status_update', { status: 'authenticated', message: 'Session authenticated' });
        console.log('WhatsApp authenticated');
    });

    client.on('auth_failure', (msg) => {
        clientStatus = 'auth_failure';
        io.emit('status_update', { status: 'auth_failure', message: `Auth failure: ${msg}` });
        console.error('Auth failure:', msg);
    });

    client.on('disconnected', (reason) => {
        clientStatus = 'disconnected';
        io.emit('status_update', { status: 'disconnected', message: `Disconnected: ${reason}` });
        console.log('WhatsApp disconnected:', reason);
        // Auto-reconnect after 5 seconds
        setTimeout(() => {
            if (clientStatus === 'disconnected') {
                client.initialize().catch(err => console.error('Reconnect error:', err));
            }
        }, 5000);
    });

    client.on('message', async (message) => {
        io.emit('incoming_message', {
            from: message.from,
            body: message.body,
            timestamp: message.timestamp,
            isGroup: message.from.includes('@g.us')
        });
    });

    return client;
}

// ===================== API ROUTES =====================

// Initialize client
app.post('/api/init', async (req, res) => {
    try {
        if (client && clientStatus === 'connected') {
            return res.json({ success: true, status: 'already_connected', message: 'Already connected' });
        }
        createClient();
        await client.initialize();
        res.json({ success: true, status: 'initializing', message: 'Client initializing. Watch for QR code.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Start pairing code method (for linked devices - requires phone number)
app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'Phone number is required (format: 1234567890)' });
    }

    try {
        // Clean the phone number
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        
        if (!client) {
            createClient();
            await client.initialize();
            // Wait a bit for client to be ready for pairing
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        // Generate pairing code
        const code = await client.requestPairingCode(cleanNumber);
        pairingCode = code;
        
        io.emit('status_update', { 
            status: 'pairing_code', 
            message: `Pairing code: ${code}`, 
            pairingCode: code,
            phoneNumber: cleanNumber
        });

        res.json({ 
            success: true, 
            pairingCode: code,
            phoneNumber: cleanNumber,
            instructions: 'Open WhatsApp > Linked Devices > Link a Device > Pair with phone number instead'
        });
    } catch (err) {
        res.status(500).json({ success: false, error: `Pairing error: ${err.message}` });
    }
});

// Get status
app.get('/api/status', (req, res) => {
    res.json({ 
        status: clientStatus, 
        connected: clientStatus === 'connected',
        hasClient: client !== null
    });
});

// Send a message
app.post('/api/send', async (req, res) => {
    const { to, message, media, type } = req.body;
    
    if (!to || (!message && !media)) {
        return res.status(400).json({ success: false, error: 'Recipient (to) and message or media required' });
    }

    if (!client || clientStatus !== 'connected') {
        return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
    }

    try {
        // Format number - ensure it's a valid WhatsApp ID
        let chatId = to.includes('@') ? to : `${to}@c.us`;
        
        if (media && type === 'media') {
            const mediaFile = MessageMedia.fromFilePath(media);
            await client.sendMessage(chatId, mediaFile, { caption: message || '' });
        } else {
            await client.sendMessage(chatId, message);
        }

        res.json({ success: true, to: chatId, message });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Broadcast to multiple contacts
app.post('/api/broadcast', async (req, res) => {
    const { contacts, message } = req.body;
    
    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
        return res.status(400).json({ success: false, error: 'Contacts array required' });
    }
    if (!message) {
        return res.status(400).json({ success: false, error: 'Message required' });
    }
    if (!client || clientStatus !== 'connected') {
        return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
    }

    const results = [];
    
    for (const contact of contacts) {
        try {
            const chatId = contact.includes('@') ? contact : `${contact}@c.us`;
            await client.sendMessage(chatId, message);
            results.push({ contact: chatId, status: 'sent' });
        } catch (err) {
            results.push({ contact, status: 'failed', error: err.message });
        }
        // Rate limiting delay
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    res.json({ success: true, results });
});

// Send file/media by URL
app.post('/api/send-media', async (req, res) => {
    const { to, url, caption } = req.body;
    
    if (!to || !url) {
        return res.status(400).json({ success: false, error: 'Recipient (to) and media URL required' });
    }
    if (!client || clientStatus !== 'connected') {
        return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
    }

    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        const media = await MessageMedia.fromUrl(url);
        await client.sendMessage(chatId, media, { caption: caption || '' });
        res.json({ success: true, to: chatId });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get chat list
app.get('/api/chats', async (req, res) => {
    if (!client || clientStatus !== 'connected') {
        return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
    }
    try {
        const chats = await client.getChats();
        const chatList = chats.slice(0, 50).map(chat => ({
            id: chat.id._serialized,
            name: chat.name || 'Unknown',
            unreadCount: chat.unreadCount,
            timestamp: chat.timestamp,
            isGroup: chat.isGroup
        }));
        res.json({ success: true, chats: chatList });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Disconnect
app.post('/api/disconnect', async (req, res) => {
    try {
        if (client) {
            await client.destroy();
            client = null;
            clientStatus = 'disconnected';
        }
        io.emit('status_update', { status: 'disconnected', message: 'Disconnected manually' });
        res.json({ success: true, message: 'Disconnected' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Logout and clear session
app.post('/api/logout', async (req, res) => {
    try {
        if (client) {
            await client.logout();
            await client.destroy();
            client = null;
            clientStatus = 'disconnected';
        }
        // Remove session files
        if (fs.existsSync(SESSION_DIR)) {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        }
        io.emit('status_update', { status: 'logged_out', message: 'Logged out. Session cleared.' });
        res.json({ success: true, message: 'Logged out and session cleared' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===================== SOCKET.IO EVENTS =====================
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Send current status on connect
    socket.emit('status_update', { 
        status: clientStatus, 
        message: `Status: ${clientStatus}` 
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// ===================== START SERVER =====================
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 WhatsApp Bot Server running on http://0.0.0.0:${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT} in your browser`);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    if (client) {
        await client.destroy().catch(() => {});
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    if (client) {
        await client.destroy().catch(() => {});
    }
    process.exit(0);
});
