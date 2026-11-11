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

app.get('/tombala', (req, res) => {
    res.sendFile(path.join(__dirname, 'tombala.html'));
});

app.get('/pisti', (req, res) => {
    res.sendFile(path.join(__dirname, 'pisti.html'));
});

function saveIpWallets() {
    try { fs.writeFileSync(IP_DB_FILE, JSON.stringify(ipWallets, null, 2)); } catch (e) {}
}

function getClientIp(socket) {
    let forwarded = socket.handshake.headers['x-forwarded-for'];
    let ip = forwarded ? forwarded.split(',').at(0).trim() : socket.handshake.address;
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
            grid[r][c] = colPools[c].splice(randIdx, 1)[0];
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
            ipWallets[clientIp].wallet = savedBalance ;
            welcomeMsg = "Tekrar hoş geldiniz! Kayıtlı bakiyenizle devam ediyorsunuz.";
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
    let drawSpeed = room.testMode ? 1000 : 4500;

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
        let hitChance = room.testMode ? 0.95 : 0.20;
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

// ==========================================
// 🃏 ÇOK MASALI CANLI PİŞTİ SUNUCUSU (SINIRSIZ MASA)
// ==========================================
let pistiRooms = {};
let pistiRoomCounter = 1;

function getAvailablePistiRoom(mode, target, forceNew = false) {
    if (!forceNew) {
        for (let id in pistiRooms) {
            let r = pistiRooms[id];
            if (!r.active && r.mode === mode && r.target === target && r.players.length < r.maxPlayers) {
                return r;
            }
        }
    }
    let roomId = "masa_" + pistiRoomCounter++;
    pistiRooms[roomId] = {
        id: roomId,
        title: `Masa #${pistiRoomCounter - 1}`,
        mode: mode,
        target: parseInt(target) || 101,
        maxPlayers: mode === 'solo' ? 2 : 4,
        players: new Array(),
        deck: new Array(),
        pile: new Array(),
        captured: Array.of(new Array(), new Array(), new Array(), new Array()),
        roundPisti: Array.of(0, 0, 0, 0),
        totalScores: Array.of(0, 0),
        turnIndex: 0,
        lastCapturer: 0,
        active: false
    };
    return pistiRooms[roomId];
}

function getPistiRoomsSummary() {
    let list = new Array();
    for (let id in pistiRooms) {
        let r = pistiRooms[id];
        if (r.players.length > 0) {
            list.push({
                id: r.id,
                title: r.title,
                mode: r.mode,
                target: r.target,
                count: r.players.length,
                max: r.maxPlayers,
                active: r.active
            });
        }
    }
    return list;
}

function createPistiDeck() {
    const suits = Array.of('♠', '♥', '♦', '♣');
    const values = Array.of('A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K');
    let d = new Array();
    for (let s of suits) {
        for (let v of values) d.push({ suit: s, value: v, isRed: (s === '♥' || s === '♦') });
    }
    for (let i = d.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        let temp = d.at(i);
        d.splice(i, 1, d.at(j));
        d.splice(j, 1, temp);
    }
    return d;
}

function broadcastPistiState(room, msg = "") {
    room.players.forEach((p, idx) => {
        if (!p.isBot) {
            io.to(p.id).emit('pistiState', {
                active: room.active,
                roomTitle: room.title,
                mode: room.mode,
                target: room.target,
                myIndex: idx,
                players: room.players.map(pl => ({ name: pl.name, isBot: pl.isBot, cardCount: pl.hand.length })),
                myHand: p.hand,
                topCard: room.pile.length > 0 ? room.pile.at(-1) : null,
                pileCount: room.pile.length,
                deckCount: room.deck.length,
                turnIndex: room.turnIndex,
                totalScores: room.totalScores,
                message: msg
            });
        }
    });
}

function startPistiRound(room) {
    room.deck = createPistiDeck();
    room.pile = new Array();
    room.captured = Array.of(new Array(), new Array(), new Array(), new Array());
    room.roundPisti = Array.of(0, 0, 0, 0);
    room.turnIndex = 0;
    room.lastCapturer = 0;
    room.active = true;
    io.emit('pistiRoomsList', getPistiRoomsSummary());

    for (let i = 0; i < 4; i++) room.pile.push(room.deck.pop());
    dealPistiCards(room);
}

function dealPistiCards(room) {
    if (room.deck.length === 0) {
        finishPistiRound(room);
        return;
    }
    for (let i = 0; i < 4; i++) {
        room.players.forEach(p => {
            if (room.deck.length > 0) p.hand.push(room.deck.pop());
        });
    }
    broadcastPistiState(room, `${room.title} | Sıra: ${room.players.at(room.turnIndex).name}`);
    checkPistiBotTurn(room);
}

function processPistiMove(room, playerIdx, cardIdx) {
    if (!room.active || room.turnIndex !== playerIdx) return;
    let p = room.players.at(playerIdx);
    if (!p || cardIdx < 0 || cardIdx >= p.hand.length) return;

    let playedCard = p.hand.splice(cardIdx, 1).at(0);
    let actionText = `${p.name} (${playedCard.value}${playedCard.suit}) attı.`;

    if (room.pile.length > 0) {
        let topCard = room.pile.at(-1);
        let isMatch = playedCard.value === topCard.value;
        let isJack = playedCard.value === 'J';

        if (isMatch || isJack) {
            let isPisti = (room.pile.length === 1 && isMatch);
            room.pile.push(playedCard);
            room.captured.at(playerIdx).push(...room.pile);
            if (isPisti) {
                let currentPisti = room.roundPisti.at(playerIdx) + (isJack ? 20 : 10);
                room.roundPisti.splice(playerIdx, 1, currentPisti);
            }
            room.lastCapturer = playerIdx;
            room.pile = new Array();
            actionText = isPisti ? `🔥 ${p.name} PİŞTİ YAPTI!` : `✨ ${p.name} yerdeki kartları topladı!`;
        } else {
            room.pile.push(playedCard);
        }
    } else {
        room.pile.push(playedCard);
    }

    room.turnIndex = (room.turnIndex + 1) % room.maxPlayers;
    let allHandsEmpty = room.players.every(pl => pl.hand.length === 0);

    if (allHandsEmpty) {
        broadcastPistiState(room, actionText);
        setTimeout(() => { dealPistiCards(room); }, 1600);
    } else {
        broadcastPistiState(room, `${actionText} | Sıra: ${room.players.at(room.turnIndex).name}`);
        checkPistiBotTurn(room);
    }
}
function checkPistiBotTurn(room) {
    if (!room.active) return;
    let currentPlayer = room.players.at(room.turnIndex);
    if (currentPlayer && currentPlayer.isBot) {
        setTimeout(() => {
            if (!room.active) return;
            let topCard = room.pile.length > 0 ? room.pile.at(-1) : null;
            let chosen = -1;
            if (topCard) {
                chosen = currentPlayer.hand.findIndex(c => c.value === topCard.value);
                if (chosen === -1 && room.pile.length >= 2) chosen = currentPlayer.hand.findIndex(c => c.value === 'J');
            }
            if (chosen === -1) {
                chosen = currentPlayer.hand.findIndex(c => c.value !== 'J');
                if (chosen === -1) chosen = 0;
            }
            processPistiMove(room, room.turnIndex, chosen);
        }, 1600);
    }
}

function calcCardsPoints(cards, pistiPts) {
    let pts = pistiPts;
    for (let c of cards) {
        if (c.value === 'A' || c.value === 'J') pts += 1;
        else if (c.suit === '♦' && c.value === '10') pts += 3;
        else if (c.suit === '♣' && c.value === '2') pts += 2;
    }
    return pts;
}

function finishPistiRound(room) {
    if (room.pile.length > 0) {
        room.captured.at(room.lastCapturer).push(...room.pile);
        room.pile = new Array();
    }

    let p1Pts = 0, p2Pts = 0, c1Count = 0, c2Count = 0;

    if (room.mode === 'solo') {
        p1Pts = calcCardsPoints(room.captured.at(0), room.roundPisti.at(0));
        p2Pts = calcCardsPoints(room.captured.at(1), room.roundPisti.at(1));
        c1Count = room.captured.at(0).length;
        c2Count = room.captured.at(1).length;
    } else {
        let t1Cards = room.captured.at(0).concat(room.captured.at(2));
        let t2Cards = room.captured.at(1).concat(room.captured.at(3));
        p1Pts = calcCardsPoints(t1Cards, room.roundPisti.at(0) + room.roundPisti.at(2));
        p2Pts = calcCardsPoints(t2Cards, room.roundPisti.at(1) + room.roundPisti.at(3));
        c1Count = t1Cards.length;
        c2Count = t2Cards.length;
    }

    if (c1Count > c2Count) p1Pts += 3;
    else if (c2Count > c1Count) p2Pts += 3;

    let newTotal1 = room.totalScores.at(0) + p1Pts;
    let newTotal2 = room.totalScores.at(1) + p2Pts;
    room.totalScores = Array.of(newTotal1, newTotal2);

    let reachedTarget = (newTotal1 >= room.target || newTotal2 >= room.target);
    let isTieAtTop = (reachedTarget && newTotal1 === newTotal2);

    if (reachedTarget && !isTieAtTop) {
        room.active = false;
        let winnerSide = newTotal1 > newTotal2 ? 1 : 2;
        io.to(room.id).emit('pistiMatchOver', {
            mode: room.mode,
            target: room.target,
            totalScores: room.totalScores,
            winnerSide: winnerSide
        });
        delete pistiRooms[room.id];
        io.emit('pistiRoomsList', getPistiRoomsSummary());
    } else {
        io.to(room.id).emit('pistiRoundSummary', {
            roundPts: Array.of(p1Pts, p2Pts),
            totalScores: room.totalScores,
            target: room.target
        });
        setTimeout(() => { startPistiRound(room); }, 3500);
    }
}

io.on('connection', (socket) => {
    socket.emit('pistiRoomsList', getPistiRoomsSummary());

    socket.on('getPistiRooms', () => {
        socket.emit('pistiRoomsList', getPistiRoomsSummary());
    });

    socket.on('joinPisti', (data) => {
        let mode = (data && data.mode === 'solo') ? 'solo' : 'team';
        let parsedTarget = data ? parseInt(data.target) : 101;
        let target = Array.of(51, 101, 151).includes(parsedTarget) ? parsedTarget : 101;
        let room = (data && data.roomId && pistiRooms[data.roomId]) ? pistiRooms[data.roomId] : getAvailablePistiRoom(mode, target, Boolean(data && data.forceNew));

        if (room.active || room.players.length >= room.maxPlayers) {
            room = getAvailablePistiRoom(mode, target, true);
        }

        socket.join(room.id);
        socket.pistiRoomId = room.id;

        let pName = (data && data.name) ? String(data.name).substring(0, 14) : ("Oyuncu_" + socket.id.substring(0, 3));
        room.players.push({ id: socket.id, name: pName, isBot: false, hand: new Array() });

        io.to(room.id).emit('pistiLobbyUpdate', {
            title: room.title,
            players: room.players.map(p => ({ name: p.name, isBot: p.isBot })),
            maxPlayers: room.maxPlayers,
            mode: room.mode,
            target: room.target
        });
        io.emit('pistiRoomsList', getPistiRoomsSummary());

        if (room.players.length === room.maxPlayers) {
            startPistiRound(room);
        }
    });

    socket.on('fillPistiBots', () => {
        let room = pistiRooms[socket.pistiRoomId];
        if (!room || room.active || room.players.length === 0) return;
        let botNum = 1;
        while (room.players.length < room.maxPlayers) {
            room.players.push({ id: "bot_" + botNum, name: "Bot_" + botNum, isBot: true, hand: new Array() });
            botNum++;
        }
        startPistiRound(room);
    });

    socket.on('playPistiCard', (data) => {
        let room = pistiRooms[socket.pistiRoomId];
        if (!room) return;
        let idx = room.players.findIndex(p => p.id === socket.id);
        if (idx !== -1 && data && typeof data.cardIndex === 'number') {
            processPistiMove(room, idx, data.cardIndex);
        }
    });

    socket.on('disconnect', () => {
        let room = pistiRooms[socket.pistiRoomId];
        if (!room) return;
        let idx = room.players.findIndex(p => p.id === socket.id);
        if (idx !== -1) {
            if (room.active) {
                room.players.at(idx).isBot = true;
                room.players.at(idx).name += " (Bot)";
                let hasHuman = room.players.some(p => !p.isBot);
                if (!hasHuman) delete pistiRooms[room.id];
                else checkPistiBotTurn(room);
            } else {
                room.players.splice(idx, 1);
                if (room.players.length === 0) delete pistiRooms[room.id];
                else {
                    io.to(room.id).emit('pistiLobbyUpdate', {
                        title: room.title,
                        players: room.players.map(p => ({ name: p.name, isBot: p.isBot })),
                        maxPlayers: room.maxPlayers,
                        mode: room.mode,
                        target: room.target
                    });
                }
            }
            io.emit('pistiRoomsList', getPistiRoomsSummary());
        }
    });
});

getOrCreateRoom(1);
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => { console.log('Odalı Eşleştirmeli Tombala Sunucusu aktif! Port: ' + PORT); });
