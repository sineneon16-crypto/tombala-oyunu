const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const ADMIN_PASSWORD = "admin123";
const IP_DB_FILE = path.join(__dirname, 'ip_wallets.json');
let ipWallets = {};
if (fs.existsSync(IP_DB_FILE)) {
    try { ipWallets = JSON.parse(fs.readFileSync(IP_DB_FILE, 'utf8')); } catch (e) { ipWallets = {}; }
}

function saveIpWallets() {
    try { fs.writeFileSync(IP_DB_FILE, JSON.stringify(ipWallets, null, 2)); } catch (e) {}
}

function getClientIp(socket) {
    let forwarded = socket.handshake.headers['x-forwarded-for'];
    let ip = forwarded ? forwarded.split(',').trim() : socket.handshake.address;
    return ip || "127.0.0.1";
}

let rooms = {}; 
let players = {}; 
function generateSingleCard() {
    let grid = Array.from({ length: 3 }, () => Array(9).fill(0));
    let colPools = Array.from({ length: 9 }, (_, i) => {
        let min = i * 10 + 1; let max = i * 10 + 9;
        if (i === 0) min = 1; if (i === 8) max = 90;
        let pool = []; for (let n = min; n <= max; n++) pool.push(n);
        return pool;
    });
    for (let r = 0; r < 3; r++) {
        let selectedCols = [];
        while (selectedCols.length < 5) {
            let c = Math.floor(Math.random() * 9);
            if (!selectedCols.includes(c) && colPools[c].length > 0) selectedCols.push(c);
        }
        selectedCols.sort((a, b) => a - b);
        selectedCols.forEach(c => {
            let randIdx = Math.floor(Math.random() * colPools[c].length);
            grid[r][c] = colPools[c].splice(randIdx, 1);
        });
    }
    for (let c = 0; c < 9; c++) {
        let activeCells = [];
        for (let r = 0; r < 3; r++) { if (grid[r][c] > 0) activeCells.push({ r: r, val: grid[r][c] }); }
        activeCells.sort((a, b) => a.val - b.val);
        activeCells.forEach((cell, index) => { grid[cell.r][c] = activeCells[index].val; });
    }
    let flatCard = [];
    for(let i=0; i<3; i++) { for(let j=0; j<9; j++) { flatCard.push(grid[i][j]); } }
    return flatCard.join(",");
}

function broadcastOnlineCount() {
    io.emit('updateOnlineCount', Object.keys(players).length);
}

function getOrCreateRoom(fee) {
    if (!rooms[fee]) {
        rooms[fee] = {
            fee: fee, bagString: "", drawnList: "", gameInterval: null,
            lobbyCountdown: 30, countdownInterval: null, gameActive: false,
            firstLineWinners: [], secondLineWinners: [], bingoWinners: [],
            currentRoundWinners: [], prizePool: 0, linePrize: 0, bingoPrize: 0,
            playerIds: [], testMode: false
        };
    }
    return rooms[fee];
}
io.on('connection', (socket) => {
    const clientIp = getClientIp(socket);
    let welcomeMsg = "";

    if (ipWallets[clientIp] === undefined) {
        ipWallets[clientIp] = { wallet: 40, lastVisit: Date.now() };
        welcomeMsg = "İlk misafir girişinize özel 40 Bakiye tanımlandı!";
    } else {
        let savedBalance = parseInt(ipWallets[clientIp].wallet);
        if (isNaN(savedBalance) || savedBalance <= 0) {
            ipWallets[clientIp].wallet = 0;
            welcomeMsg = "Bakiyeniz 0. Reklam izleyerek +10 Bakiye kazanabilirsiniz!";
        } else {
            ipWallets[clientIp].wallet = savedBalance + 5;
            welcomeMsg = "Tekrar hoş geldiniz! Giriş bonusu olarak +5 Bakiye eklendi.";
        }
        ipWallets[clientIp].lastVisit = Date.now();
    }
    saveIpWallets();
    players[socket.id] = {
        id: socket.id,
        ip: clientIp,
        name: "Misafir_" + socket.id.substring(0,3),
        cards: [generateSingleCard(), generateSingleCard(), generateSingleCard(), generateSingleCard()],
        wallet: ipWallets[clientIp].wallet,
        entryFee: 1,
        cardCount: 0,
        isAdmin: false
    };

    let room = getOrCreateRoom(1);
    room.playerIds.push(socket.id);
    socket.join("room_" + 1);
    broadcastOnlineCount();

    if (!room.gameActive && !room.countdownInterval) { startLobbyTimer(1); }

    socket.on('setPlayerName', (data) => {
        if (players[socket.id] && data && data.name) {
            players[socket.id].name = String(data.name).substring(0, 18);
        }
    });
        socket.on('adminLogin', (data) => {
        if (data && data.password === ADMIN_PASSWORD) {
            if (players[socket.id]) {
                players[socket.id].isAdmin = true;
                players[socket.id].wallet = 999999;
                ipWallets[players[socket.id].ip].wallet = 999999;
                saveIpWallets();
                socket.emit('walletUpdated', { wallet: 999999 });
            }
            socket.emit('adminAuthResult', { success: true });
        } else {
            socket.emit('adminAuthResult', { success: false });
        }
    });

    socket.on('adminCommand', (data) => {
        let p = players[socket.id];
        if (!p || !p.isAdmin) return;
        let room = getOrCreateRoom(p.entryFee);

        if (data.action === 'toggleTestMode') {
            room.testMode = !!data.enabled;
            io.to("room_" + p.entryFee).emit('testModeStatus', { enabled: room.testMode });
            if (room.gameActive) {
                clearInterval(room.gameInterval);
                startDrawLoop(p.entryFee);
            }
        } else if (data.action === 'forceStart') {
            if (!room.gameActive) {
                if (room.countdownInterval) { clearInterval(room.countdownInterval); room.countdownInterval = null; }
                launchGameInRoom(p.entryFee);
            }
        }
        else if (data.action === 'addCoins') {
            p.wallet = parseInt(p.wallet) + parseInt(data.amount || 100);
            ipWallets[p.ip].wallet = p.wallet;
            saveIpWallets();
            socket.emit('walletUpdated', { wallet: p.wallet });
        } else if (data.action === 'forceReset') {
            room.gameActive = false;
            if (room.gameInterval) clearInterval(room.gameInterval);
            if (room.countdownInterval) clearInterval(room.countdownInterval);
            io.to("room_" + p.entryFee).emit('onlineBingo', { winner: "Admin Sıfırladı", winnerId: null, prize: 0, updatedWallet: 0 });
            setTimeout(() => { startLobbyTimer(p.entryFee); }, 2000);
        }
    });

    socket.on('adRewardClaimed', () => {
        let p = players[socket.id];
        if (!p) return;
        p.wallet = parseInt(p.wallet) + 10;
        ipWallets[p.ip].wallet = p.wallet;
        saveIpWallets();
        socket.emit('walletUpdated', { wallet: p.wallet });
    });
        socket.on('setEntryFee', (data) => {
        let p = players[socket.id];
        if (!p) return;

        let oldFee = p.entryFee;
        let newFee = parseInt(data.fee);
        if (isNaN(newFee) || newFee <= 0 || oldFee === newFee) return;

        let oldRoom = rooms[oldFee];
        if (oldRoom) {
            oldRoom.playerIds = oldRoom.playerIds.filter(id => id !== socket.id);
            socket.leave("room_" + oldFee);
            if (oldRoom.playerIds.length === 0) {
                if (oldRoom.countdownInterval) { clearInterval(oldRoom.countdownInterval); oldRoom.countdownInterval = null; }
                if (oldRoom.gameInterval) { clearInterval(oldRoom.gameInterval); oldRoom.gameInterval = null; }
                oldRoom.gameActive = false;
            }
        }

        p.entryFee = newFee;
        p.cardCount = 0;
        let newRoom = getOrCreateRoom(newFee);
        if (!newRoom.playerIds.includes(socket.id)) {
            newRoom.playerIds.push(socket.id);
        }
        socket.join("room_" + newFee);

        // Yeni odanın mevcut durumunu oyuncuya anında bildir
        socket.emit('testModeStatus', { enabled: !!newRoom.testMode });
        if (newRoom.gameActive) {
            socket.emit('gameStarted', { linePrize: newRoom.linePrize, bingoPrize: newRoom.bingoPrize });
            socket.emit('numberDrawn', { num: null, history: newRoom.drawnList.split(",").filter(Boolean) });
        } else {
            if (!newRoom.countdownInterval) {
                startLobbyTimer(newFee);
            } else {
                socket.emit('lobbyCountdown', newRoom.lobbyCountdown);
            }
        }
    });

    socket.on('setCardCount', (data) => {
        let p = players[socket.id];
        if(p) {
            let room = rooms[p.entryFee];
            if (room && !room.gameActive) {
                let count = parseInt(data.count); 
                if (isNaN(count) || count < 0 || count > 4) return;
                p.cardCount = count;
                if (data.wallet !== undefined) { 
                    p.wallet = Math.max(0, parseInt(data.wallet));
                    ipWallets[p.ip].wallet = p.wallet;
                    saveIpWallets();
                }
                socket.emit('walletUpdated', { wallet: parseInt(p.wallet) });
            }
        }
    });
    socket.on('syncCardsToServer', (data) => {
        let p = players[socket.id];
        if(p && data.cards) {
            let room = rooms[p.entryFee];
            if (room && !room.gameActive) { p.cards = data.cards; }
        }
        if(p && data.wallet !== undefined) {
            p.wallet = Math.max(0, parseInt(data.wallet));
            ipWallets[p.ip].wallet = p.wallet;
            saveIpWallets();
            socket.emit('walletUpdated', { wallet: parseInt(p.wallet) });
        }
    });

    socket.on('claimAward', (data) => {
        let p = players[socket.id]; if (!p) return;
        let room = rooms[p.entryFee]; if (!room || !room.gameActive || p.cardCount <= 0) return;

        let type = parseInt(data.type);
        let drawnArr = room.drawnList.split(",").filter(Boolean).map(s => String(s).trim());
        let hasValidClaim = false;
        let activeCardsToCheck = p.cards.slice(0, p.cardCount);
        activeCardsToCheck.forEach((cardString) => {
            let cardArr = cardString.split(",").map(s => String(s).trim());
            let completedLines = 0;
            for (let i = 0; i < 3; i++) {
                let requiredNumbers = 0; let matchedNumbers = 0;
                for (let j = 0; j < 9; j++) {
                    let cellNum = cardArr[(i * 9) + j];
                    if (cellNum && cellNum !== "0" && cellNum !== "") {
                        requiredNumbers++; if (drawnArr.includes(cellNum)) { matchedNumbers++; }
                    }
                }
                if (requiredNumbers > 0 && matchedNumbers === requiredNumbers) { completedLines++; }
            }
            if (type === 1 && completedLines >= 1) hasValidClaim = true;
            if (type === 2 && completedLines >= 2 && room.firstLineWinners.length > 0) hasValidClaim = true; 
            if (type === 3 && completedLines === 3 && room.secondLineWinners.length > 0) hasValidClaim = true; 
        });

        if (hasValidClaim) {
            if (type === 1 && !room.firstLineWinners.includes(socket.id)) {
                room.firstLineWinners.push(socket.id); room.currentRoundWinners.push({ id: socket.id, type: 1 });
                io.to("room_" + p.entryFee).emit('onlineCinko', { id: socket.id, name: p.name, type: 1 });
            } else if (type === 2 && !room.secondLineWinners.includes(socket.id)) {
                room.secondLineWinners.push(socket.id); room.currentRoundWinners.push({ id: socket.id, type: 2 });
                io.to("room_" + p.entryFee).emit('onlineCinko', { id: socket.id, name: p.name, type: 2 });
            } else if (type === 3 && !room.bingoWinners.includes(socket.id)) {
                room.bingoWinners.push(socket.id); room.currentRoundWinners.push({ id: socket.id, type: 3 });
                processRoundClaims(p.entryFee);
            }
        }
    });
    socket.on('sendMessage', (msg) => {
        let p = players[socket.id];
        if(p && msg.trim() !== "") { io.to("room_" + p.entryFee).emit('receiveMessage', { sender: p.name, text: msg }); }
    });

    socket.emit('init', { id: socket.id, cards: players[socket.id].cards, wallet: parseInt(players[socket.id].wallet), welcomeMsg: welcomeMsg });

    socket.on('disconnect', () => {
        let p = players[socket.id];
        if (p) {
            ipWallets[p.ip].wallet = Math.max(0, parseInt(p.wallet));
            saveIpWallets();
            let room = rooms[p.entryFee];
            if (room) {
                room.playerIds = room.playerIds.filter(id => id !== socket.id);
                if (room.playerIds.length === 0) { clearInterval(room.gameInterval); clearInterval(room.countdownInterval); delete rooms[p.entryFee]; }
            }
            delete players[socket.id];
        }
        broadcastOnlineCount();
    });
});
function launchGameInRoom(fee) {
    let room = rooms[fee]; if (!room) return;
    room.gameActive = true;
    let totalCollectedFee = 0;
    room.playerIds.forEach(id => { 
        let p = players[id]; 
        if (p && p.cardCount > 0) { totalCollectedFee += (parseInt(p.entryFee) * parseInt(p.cardCount)); } 
    });
    room.prizePool = totalCollectedFee - (totalCollectedFee * 0.10);
    room.linePrize = Math.floor(room.prizePool * 0.25); 
    room.bingoPrize = Math.floor(room.prizePool * 0.50);
    room.playerIds.forEach(id => { io.to(id).emit('gameStarted', { linePrize: room.linePrize, bingoPrize: room.bingoPrize }); });
    startDrawLoop(fee);
}

function startLobbyTimer(fee) {
    let room = rooms[fee]; if (!room) return;
    room.bagString = "";
    for(let i = 1; i <= 90; i++) { room.bagString = room.bagString + i + ","; }
    room.drawnList = ""; room.firstLineWinners = []; room.secondLineWinners = []; room.bingoWinners = []; room.currentRoundWinners = [];
    room.lobbyCountdown = room.testMode ? 8 : 25;
    io.to("room_" + fee).emit('lobbyCountdown', room.lobbyCountdown);

    room.countdownInterval = setInterval(() => {
        room.lobbyCountdown--;
        if (room.lobbyCountdown > 0) { io.to("room_" + fee).emit('lobbyCountdown', room.lobbyCountdown); } 
        else {
            clearInterval(room.countdownInterval); room.countdownInterval = null;
            launchGameInRoom(fee);
        }
    }, 1000);
}
function startDrawLoop(fee) {
    let room = rooms[fee]; if (!room) return;
    let drawSpeed = room.testMode ? 1000 : 2500;

    room.gameInterval = setInterval(() => {
        if (!room || !room.gameActive) { 
            if(room) clearInterval(room.gameInterval); 
            return; 
        }

        processRoundClaims(fee);
        if (!room.gameActive) return;

        let currentBag = room.bagString.split(",").filter(Boolean);

        if (currentBag.length === 0) {
            room.gameActive = false;
            clearInterval(room.gameInterval);
            io.to("room_" + fee).emit('onlineBingo', { 
                winner: "Kimse (Tüm Sayılar Çekildi)", 
                winnerId: null, 
                prize: 0, 
                updatedWallet: 0 
            });
            setTimeout(() => { startLobbyTimer(fee); }, 5000);
            return;
        }
        let activeCardNumbers = [];
        room.playerIds.forEach(id => {
            let p = players[id];
            if (p && p.cardCount > 0) {
                p.cards.slice(0, p.cardCount).forEach(cardStr => {
                    cardStr.split(",").forEach(n => {
                        let cleanN = String(n).trim();
                        if (cleanN && cleanN !== "0" && currentBag.includes(cleanN)) {
                            activeCardNumbers.push(cleanN);
                        }
                    });
                });
            }
        });

        let num;
        let hitChance = room.testMode ? 0.95 : 0.70;
        if (activeCardNumbers.length > 0 && Math.random() < hitChance) {
            num = activeCardNumbers[Math.floor(Math.random() * activeCardNumbers.length)];
        } else {
            num = currentBag[Math.floor(Math.random() * currentBag.length)];
        }

        if (!num) return;

        let rIdx = currentBag.indexOf(num);
        if (rIdx !== -1) currentBag.splice(rIdx, 1);

        room.bagString = currentBag.join(",") + ",";
        room.drawnList = room.drawnList + num + ",";
        io.to("room_" + fee).emit('numberDrawn', { num: num, history: room.drawnList.split(",").filter(Boolean) });
    }, drawSpeed); 
}

function processRoundClaims(fee) {
    let room = rooms[fee]; if (!room) return;
    let bBasanlar = room.currentRoundWinners.filter(w => w.type === 3);

    if (bBasanlar.length > 0 && room.gameActive) {
        room.gameActive = false; 
        clearInterval(room.gameInterval);
        let sharedBingoPrize = Math.floor(room.bingoPrize / bBasanlar.length);
        bBasanlar.forEach(w => { 
            if (players[w.id]) { 
                players[w.id].wallet = parseInt(players[w.id].wallet) + parseInt(sharedBingoPrize); 
                ipWallets[players[w.id].ip].wallet = players[w.id].wallet;
                saveIpWallets();
                io.to("room_" + fee).emit('onlineBingo', { winner: players[w.id].name, winnerId: w.id, prize: sharedBingoPrize, updatedWallet: parseInt(players[w.id].wallet) }); 
            } 
        });
        setTimeout(() => { startLobbyTimer(fee); }, 5000);
    }
    room.currentRoundWinners = [];
}

getOrCreateRoom(1);
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log('Odalı Eşleştirmeli Tombala Sunucusu aktif! Port: ' + PORT); });