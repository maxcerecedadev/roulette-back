// Core
const express = require('express');
const cors = require('cors');
const { createServer } = require('node:http');
const { Server: SocketServer } = require('socket.io');

// Puerto y configuración
const PORT = process.env.PORT || 2000;
const MAX_BETS = process.env.MAX_BETS || 4;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '1234567'; // Cambia esto por un token seguro en producción

// Inicializar el servidor
const app = express();
app.use(cors());
app.use(express.json()); // Para manejar JSON en las peticiones
const server = createServer(app);
const io = new SocketServer(server, {
    cors: {
        origin: '*',
        credentials: false
    }
});

// Almacenamiento en memoria para resultados de un solo jugador
// { roomId: [resultados futuros...] }
const singlePlayerRooms = {};

// Almacenamiento en memoria para salas de torneos
const tournamentRooms = [];

// Clases y utilidades del juego
class RouletteEngine {
    constructor(queueSize = 10) {
        this.queueSize = queueSize;
        this.resultsQueue = [];
        this.fillQueue();
    }
    
    static RED_NUMBERS = new Set([
        1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36
    ]);

    generateRandomNumber() {
        return Math.floor(Math.random() * 37);
    }
    
    numberToColor(n) {
        if (n === 0) return 'green';
        if (RouletteEngine.RED_NUMBERS.has(n)) return 'red';
        return 'black';
    }
    
    fillQueue() {
        while (this.resultsQueue.length < this.queueSize) {
            const num = this.generateRandomNumber();
            const color = this.numberToColor(num);
            this.resultsQueue.push({ number: num, color });
        }
    }
    
    getNextResult() {
        if (this.resultsQueue.length === 0) {
            this.fillQueue();
        }
        const result = this.resultsQueue.shift();
        this.fillQueue(); // Mantener la cola llena
        return result;
    }
    
    peekQueue() {
        return [...this.resultsQueue];
    }
}

class TournamentRoom {
    name;
    players = [];
    maxPlayers = 3;
    started = false;
    rouletteEngine;

    constructor(name) {
        this.name = name;
        this.rouletteEngine = new RouletteEngine(10);
    }
    
    getPlayersCount() {
        return this.players.length;
    }

    isSeatAvailable() {
        return !this.started && this.getPlayersCount() < this.maxPlayers;
    }
    
    addPlayer(player) {
        const seatAvailable = this.isSeatAvailable();
        if(seatAvailable) {
            this.players.push(player);
            if(!this.isSeatAvailable()) {
                this.started = true;
            }
        } else {
            throw new Error('Could not add player: room full');
        }
    }
    
    removePlayer(id) {
        const index = this.players.findIndex(player => player.id === id);
        if (index >= 0) this.players.splice(index, 1);
    }
    
    getPlayerByName(name) {
        return this.players.find(player => player.name === name);
    }
    
    getPlayers() {
        return this.players;
    }
    
    start() {
        this.started = true;
    }
}

class User {
    id;
    name;
    balance;
    defaultBalance;
    betsPlaced;
    maxBets = MAX_BETS;
    
    constructor(id, name, balance = 10000) {
        this.id = id;
        this.name = name;
        this.defaultBalance = balance;
        this.balance = balance;
        this.betsPlaced = 0;
    }
    
    setBalance(newBalance) {
        this.balance = newBalance;
    }
    
    reset() {
        this.betsPlaced = 0;
        this.balance = this.defaultBalance;
    }
    
    areAllBetsPlaced() {
        return this.betsPlaced >= this.maxBets;
    }
    
    setBetsPlaced(n) {
        this.betsPlaced = n;
    }
    
    placeBet() {
        if(!this.areAllBetsPlaced()) {
            this.betsPlaced++;
        } else {
            throw new Error('Max bets placed');
        }
    }
    
    getBetsCount() {
        return this.betsPlaced;
    }
    
    toSocketData() {
        return {
            name: this.name,
            balance: this.balance,
            betCount: this.getBetsCount()
        }
    }
}

// Funciones para la lógica de la ruleta
function generateSpin() {
    const number = Math.floor(Math.random() * 37); // 0-36
    const color = number === 0 ? "green" : number % 2 === 0 ? "black" : "red";
    return { number, color };
}

// Función que asegura que siempre haya 10 resultados en la cola para una sala
function ensureFutureResults(roomId) {
    if (!singlePlayerRooms[roomId]) {
        singlePlayerRooms[roomId] = [];
    }
    while (singlePlayerRooms[roomId].length < 10) {
        singlePlayerRooms[roomId].push(generateSpin());
    }
}

const didAllPlayersPlaceAllBets = (players) => {
    return players.every(player => player.areAllBetsPlaced() || player.balance <= 0);
}

const isGameOver = (players) => {
    return didAllPlayersPlaceAllBets(players);
}

// Middleware de autenticación para el administrador
function adminAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    let token = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
    } else if (req.query && req.query.admin_token) {
        token = req.query.admin_token;
    }
    if (!token || token !== ADMIN_TOKEN) {
        console.warn('Unauthorized peek attempt from', req.ip);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// Rutas HTTP para el administrador (Express)
app.get("/peek/:roomId", adminAuth, (req, res) => {
    const { roomId } = req.params;
    const results = singlePlayerRooms[roomId];
    if (!results) {
        return res.status(404).json({ error: "Room not found" });
    }
    res.json({ roomId, nextResults: results });
});

// Eventos de Socket.IO
io.on('connection', (socket) => {
    let player;
    let tRoom;
    
    console.log(`Un nuevo jugador se ha conectado. ID de socket: ${socket.id}`);

    // Maneja la unión para el modo de un solo jugador
    socket.on('single-join', (callback) => {
        const roomId = socket.id;
        ensureFutureResults(roomId);
        console.log(`Jugador unido a la sala single con ID: ${roomId}`);
        callback({ message: "Unido a la sala", roomId: roomId });
    });

    // Maneja la petición de giro para el modo de un solo jugador
    socket.on('single-spin', (data, callback) => {
        const roomId = data.roomId;
        if (!singlePlayerRooms[roomId]) {
            return callback({ error: "Room not found" });
        }
        
        const result = singlePlayerRooms[roomId].shift();
        ensureFutureResults(roomId);
        
        console.log(`Resultado en sala ${roomId}:`, result);
        callback({ message: "Resultado obtenido", result: result });
    });

    // Eventos de torneo (t- significa torneo)
    socket.on('t-user-update', (msg) => {
        const data = JSON.parse(msg);
        const newBalance = parseInt(data.balance);
        const betsPlaced = data.betCount;

        const playerObj = tRoom.getPlayerByName(data.name);
        playerObj.setBalance(newBalance);
        playerObj.setBetsPlaced(betsPlaced);

        const allPlayers = tRoom.getPlayers();

        if (isGameOver(allPlayers)) {
            console.log('game over');
            socket.nsp.to(tRoom.name).emit("t-game-over", JSON.stringify(
                tRoom.getPlayers().map(_player => _player.toSocketData())
            ));
            deleteRoom(tRoom);
            tRoom = null;
        } else {
            socket.nsp.to(tRoom.name).emit('t-user-update', JSON.stringify(playerObj.toSocketData()));
        }
    });

    socket.on('t-join', (msg, callback) => {
        const data = JSON.parse(msg);
        let tRoom = tournamentRooms.find(room => room.isSeatAvailable());

        if(!tRoom) {
            tRoom = new TournamentRoom(`t${tournamentRooms.length}`);
            tournamentRooms.push(tRoom);
        }

        const player = new User(socket.id, data.name);
        tRoom.addPlayer(player);
        
        socket.join(tRoom.name);
        console.log(`Jugador ${player.name} unido a la sala de torneo ${tRoom.name}`);

        socket.broadcast.to(tRoom.name).emit('t-join', JSON.stringify(player.toSocketData()));
        callback(JSON.stringify(tRoom.getPlayers().map(p => p.toSocketData())));
    });

    socket.on('t-spin', (msg, callback) => {
        try {
            if (!tRoom) {
                const err = 'No room found for player';
                console.warn(err);
                if (callback) callback(JSON.stringify({ error: err }));
                return;
            }
            const engine = tRoom.rouletteEngine;
            const result = engine.getNextResult();
            socket.nsp.to(tRoom.name).emit('t-spin-result', JSON.stringify(result));
            if (callback) callback(JSON.stringify(result));
            console.log(`Room ${tRoom.name} spin result:`, result);
            console.log(`Room ${tRoom.name} upcoming queue:`, engine.peekQueue().map(r => `${r.number}:${r.color}`).join(' | '));
        } catch (e) {
            console.error('Error on t-spin:', e);
            if (callback) callback(JSON.stringify({ error: e.message }));
        }
    });

    socket.on('t-leave', (msg) => {
        if(tRoom && player) {
            tRoom.removePlayer(player.id);
            socket.leave(tRoom.name);
            socket.broadcast.to(tRoom.name).emit('t-leave', JSON.stringify(player.toSocketData()));
        }
    });

    socket.on('disconnect', () => {
        // Limpia la sala de un solo jugador si existe
        if (singlePlayerRooms[socket.id]) {
            delete singlePlayerRooms[socket.id];
            console.log(`Sala single ${socket.id} eliminada.`);
        }
        // Limpia la sala de torneo si es el último jugador
        if (tRoom && tRoom.getPlayersCount() <= 1) {
            const index = tournamentRooms.findIndex(_room => _room.name === tRoom.name);
            if (index >= 0) tournamentRooms.splice(index, 1);
        }
    });
});

// Iniciar el servidor
server.listen(PORT, () => {
    console.log('Servidor escuchando en el puerto ' + PORT);
});

// Funciones auxiliares para el modo de torneo (necesitan ser definidas)
// No estaban en tu código original, pero son necesarias para los eventos.
const deleteRoom = (room) => {
    const index = tournamentRooms.findIndex(_room => _room.name === room.name);
    if (index >= 0) tournamentRooms.splice(index, 1);
};